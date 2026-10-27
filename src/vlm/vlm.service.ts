import { isValidObjectId } from 'mongoose';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import {
  VLM_SOURCE_CATEGORY,
  buildJsonPrompt,
  isSupportedImage,
  normalizeMode,
  vlmStageLabel,
} from '../../utils/constant/vlm.ts';
import vlmConfig, { defaultPromptFor } from '../../utils/vlm/vlm.config.ts';
import { getVlmClient } from '../../utils/vlm/VlmHttpClient.ts';
import { fileService } from '../file/file.service.ts';
import { removeFileQuietly } from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import { vlmTaskRepository } from './vlmTask.repository.ts';
import { vlmDispatcher } from './vlmDispatcher.ts';
import type { VlmTaskDocument } from './vlmTask.entity.ts';
import type { FileDocument } from '../file/file.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { Vlm } from '../../type/index.d.ts';

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/** 字节数 → MB 文案（错误提示用） */
const formatMb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MB`;

/** 任务创建入参 */
interface StartTaskInput {
  sourceType: Vlm.SourceType;
  sourceFileId: string;
  originalName: string;
  prompt: string;
  mode: Vlm.Mode;
  userId?: string;
}

/**
 * 图片理解服务。
 *
 * 提交只负责「校验 + 登记源图片 + 建任务 + 唤醒调度器」，不在请求链路里跑推理 ——
 * 容器首次收到任务还要冷加载模型（数十秒到分钟级），因此由 vlmDispatcher 异步领取执行，
 * 客户端轮询 GET /tasks/:taskId 取进度。
 */
class VlmService {
  /**
   * 提交理解任务（multipart 上传的图片）。
   *
   * 复用 multer 已落盘的文件：类型/体积预检不通过就直接删掉，避免为非法输入白建一条 file 记录。
   */
  async submitFromFile(
    file: Express.Multer.File,
    dto: Vlm.SubmitTaskDto,
  ): Promise<ServiceResult<Vlm.TaskAccepted>> {
    if (!vlmConfig.enabled) {
      removeFileQuietly(file.path);
      return this.disabled();
    }
    if (!vlmConfig.configured) {
      removeFileQuietly(file.path);
      return this.unconfigured();
    }

    if (file.size > vlmConfig.maxImageBytes) {
      removeFileQuietly(file.path);
      return {
        error: `图片大小不能超过 ${formatMb(vlmConfig.maxImageBytes)}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }
    if (!isSupportedImage(file.mimetype, file.originalname)) {
      removeFileQuietly(file.path);
      return {
        error: `不支持的图片类型：${file.mimetype || '未知'}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    const userId = dto.userId ?? '';
    /** 是否已登记进 file 表：已登记就不能再删磁盘文件，否则 file 记录会指向不存在的文件 */
    let registered = false;

    try {
      const { created } = await fileService.upload(file, {
        category: VLM_SOURCE_CATEGORY,
        ...(userId ? { createBy: userId } : {}),
      });
      registered = true;

      return await this.startTask({
        sourceType: 'upload',
        sourceFileId: String(created._id),
        originalName: file.originalname,
        prompt: this.resolvePrompt(dto),
        mode: normalizeMode(dto.mode),
        userId,
      });
    } finally {
      if (!registered) removeFileQuietly(file.path);
    }
  }

  /**
   * 提交理解任务（引用已有 file 记录）。
   *
   * 与 submitFromFile 的差别只在「图片从哪来」，其余流程完全一致。这条口径也是后续
   * 「场景关键帧 → 语义理解」的接入点：抽帧产物先落 file 表，再按 fileId 提交理解。
   */
  async submitFromFileId(
    fileId: string,
    dto: Vlm.SubmitTaskDto,
  ): Promise<ServiceResult<Vlm.TaskAccepted>> {
    if (!vlmConfig.enabled) return this.disabled();
    if (!vlmConfig.configured) return this.unconfigured();

    const id = (fileId ?? '').trim();
    const checked = await this.validateSourceFile(id);
    if ('error' in checked) return checked;

    return this.startTask({
      sourceType: 'fileId',
      sourceFileId: id,
      originalName: checked.file.originalName,
      prompt: this.resolvePrompt(dto),
      mode: normalizeMode(dto.mode),
      ...(dto.userId ? { userId: dto.userId } : {}),
    });
  }

  /** 查询任务（带归属校验） */
  async getTask(taskId: string, userId: string): Promise<ServiceResult<Vlm.TaskRecord>> {
    if (!isValidObjectId(taskId)) return { error: '任务不存在', code: HttpStatus.NOT_FOUND };

    const task = await vlmTaskRepository.findById(taskId);
    if (!task) return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的图片理解任务', code: HttpStatus.FORBIDDEN };
    }
    return { data: this.toRecord(task) };
  }

  /** 分页查询当前用户的任务 */
  async listTasks(
    userId: string,
    query: Vlm.TaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<Vlm.TaskRecord>>> {
    const page = await vlmTaskRepository.findPageByUser({
      userId,
      ...(query.status ? { status: query.status } : {}),
      page: query.page,
      limit: query.limit,
    });
    return {
      data: {
        list: page.list.map((doc) => this.toRecord(doc)),
        total: page.total,
        page: page.page,
        limit: page.limit,
      },
    };
  }

  /**
   * 取消一条排队中的任务。
   *
   * 仅 status=pending 可取消：取消走仓储的原子条件更新（与 claimNextPending 互斥），
   * 已被领取执行、已完成/失败的任务一律拒绝。
   */
  async cancel(taskId: string, userId: string): Promise<ServiceResult<Vlm.TaskRecord>> {
    if (!isValidObjectId(taskId)) return { error: '任务不存在', code: HttpStatus.NOT_FOUND };

    const task = await vlmTaskRepository.findById(taskId);
    if (!task) return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    if (task.userId !== userId) {
      return { error: '只能取消当前用户自己的图片理解任务', code: HttpStatus.FORBIDDEN };
    }
    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    const cancelled = await vlmTaskRepository.cancelPending(taskId);
    if (!cancelled) {
      // 读取与取消之间被 dispatcher 领取（条件更新与 claimNextPending 互斥）
      return { error: '任务已被调度器领取，无法取消', code: HttpStatus.CONFLICT };
    }
    return { data: this.toRecord(cancelled) };
  }

  /**
   * 查询任务排队位置。口径与 claimNextPending 的领取顺序（createdAt 升序 FIFO）一致。
   * 注意 count 与领取不是原子的：返回的是查询瞬间的快照。
   */
  async getQueuePosition(
    taskId: string,
    userId: string,
  ): Promise<ServiceResult<Vlm.QueuePosition>> {
    if (!isValidObjectId(taskId)) return { error: '任务不存在', code: HttpStatus.NOT_FOUND };

    const task = await vlmTaskRepository.findById(taskId);
    if (!task) return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的图片理解任务', code: HttpStatus.FORBIDDEN };
    }

    const [queueDepth, running] = await Promise.all([
      vlmTaskRepository.countPending(),
      vlmTaskRepository.countRunning(),
    ]);

    let position: number | null = null;
    let waitingAhead = 0;
    if (task.status === 'pending') {
      const before = await vlmTaskRepository.countPendingBefore(task.createdAt);
      position = before + 1;
      waitingAhead = before + running;
    }

    return { data: { taskId, status: task.status, position, waitingAhead, queueDepth, running } };
  }

  /** 队列计数（全局口径，不针对具体任务、也不要求归属） */
  async getQueueStatus(): Promise<ServiceResult<Vlm.QueueStatus>> {
    const [pending, running] = await Promise.all([
      vlmTaskRepository.countPending(),
      vlmTaskRepository.countRunning(),
    ]);
    return { data: { total: pending + running, pending, running } };
  }

  /**
   * 引擎状态（进程内视角）。
   *
   * 注意 `reachable` 的语义是「容器侧模型在位」，**不是**「服务是否可用」：容器默认懒加载
   * （`VLM_EAGER_LOAD=false`）+ 空闲卸载（`VLM_IDLE_UNLOAD_MS`），未用过或空闲超时被卸载后
   * `/readyz` 都会是 503，因此这里为 false —— **这是预期行为**，不代表服务坏了。
   * 调度器同样不拿它当闸门（否则会造成「不加载就不领取、不领取就永不加载」的死锁）。
   */
  async getEngineStatus(): Promise<ServiceResult<Vlm.EngineStatus>> {
    const queueDepth = await vlmTaskRepository.countPending().catch(() => 0);
    const reachable = vlmConfig.configured ? await getVlmClient().ready() : false;

    return {
      data: {
        workerId: getWorkerId(),
        enabled: vlmConfig.enabled,
        configured: vlmConfig.configured,
        reachable,
        leader: vlmDispatcher.isLeader(),
        baseUrl: vlmConfig.baseUrl,
        queueDepth,
        concurrency: vlmDispatcher.getConcurrency(),
        activeCount: vlmDispatcher.getActiveCount(),
        lastProgress: vlmDispatcher.getLastProgress(),
      },
    };
  }

  /** 建任务 + 唤醒调度器（没有 start()，任务会一直躺在 pending 里） */
  private async startTask(input: StartTaskInput): Promise<ServiceResult<Vlm.TaskAccepted>> {
    const task = await vlmTaskRepository.create({
      sourceType: input.sourceType,
      sourceFileId: input.sourceFileId,
      sourceUrl: `/api/files/${input.sourceFileId}/download`,
      originalName: input.originalName,
      prompt: input.prompt,
      mode: input.mode,
      ...(input.userId ? { userId: input.userId } : {}),
    });

    vlmDispatcher.start();
    return { data: { taskId: String(task._id), mode: input.mode, status: task.status } };
  }

  /**
   * 归一化指令。
   *
   * **json 模式下自定义 prompt 只作为「description 的内容要求」并入输出信封**，不参与决定
   * 输出结构（见 `buildJsonPrompt` 的分层说明）。因此任意 prompt 都能稳定拿到结构化 JSON：
   * 「200字描述」= description 写 200 字，其余四个字段照常；「重点关注人物穿着」= description
   * 聚焦穿着，结构不变。
   *
   * 这里刻意**不做**「prompt 里是否已含字段清单」这类包含判断：那等于让调用方传的内容反过来
   * 决定输出结构，正是要避免的事。
   *
   * 落库而非只在执行时算 —— 换个默认措辞后，旧任务仍然能说清当初用的是哪句。
   */
  private resolvePrompt(dto: Vlm.SubmitTaskDto): string {
    const mode = normalizeMode(dto.mode);
    const given = (dto.prompt ?? '').trim();

    // text 模式不要求 JSON，自定义 prompt 直接生效（它就是「整段输出」的要求）
    if (mode === 'text') return given || defaultPromptFor('text');

    if (!given) return defaultPromptFor('json');
    return buildJsonPrompt(given);
  }

  /**
   * 源图片校验：id 合法性 → 记录存在 → 磁盘在 → 体积上限 → 图片类型。
   * 提交时即校验，让用户立刻拿到 400/404，而不是等任务跑起来才通过轮询发现。
   */
  private async validateSourceFile(
    fileId: string,
  ): Promise<{ file: FileDocument } | { error: string; code: number }> {
    const id = (fileId ?? '').trim();
    if (!id || !isValidObjectId(id)) {
      return { error: '非法的图片文件 id', code: HttpStatus.BAD_REQUEST };
    }

    const file = await fileService.getById(id);
    if (!file) return { error: '图片文件不存在', code: HttpStatus.NOT_FOUND };
    if (!fileService.fileExistsOnDisk(file)) {
      return { error: '图片文件已丢失，请重新上传', code: HttpStatus.NOT_FOUND };
    }
    if (file.size > vlmConfig.maxImageBytes) {
      return {
        error: `图片大小不能超过 ${formatMb(vlmConfig.maxImageBytes)}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }
    if (!isSupportedImage(file.mimeType, file.originalName)) {
      return {
        error: `不支持的图片类型：${file.mimeType || '未知'}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }
    return { file };
  }

  /** 开关关闭时的统一响应 */
  private disabled(): ServiceResult<never> {
    return { error: '图片理解未启用，暂不支持', code: HttpStatus.SERVICE_UNAVAILABLE };
  }

  /**
   * 客户端未配置时的统一响应。
   *
   * 刻意在**提交**就拦掉，而不是收下任务让它在执行时失败 —— 收下只能给用户一个 taskId，
   * 他要轮询一次才知道「根本没接容器」。
   */
  private unconfigured(): ServiceResult<never> {
    return {
      error: '图片理解服务未配置（需 VLM_MODE=remote 且设置 VLM_BASE_URL）',
      code: HttpStatus.SERVICE_UNAVAILABLE,
    };
  }

  /** 落库文档 → 对外记录（_id 映射为 id，并附带阶段中文描述） */
  private toRecord(doc: VlmTaskDocument): Vlm.TaskRecord {
    const result = doc.result;
    return {
      id: String(doc._id),
      status: doc.status,
      sourceType: doc.sourceType,
      sourceFileId: doc.sourceFileId,
      sourceUrl: doc.sourceUrl,
      originalName: doc.originalName,
      prompt: doc.prompt,
      mode: doc.mode,
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: vlmStageLabel(doc.stage),
      message: doc.message,
      ...(result
        ? {
            result: {
              description: result.description,
              objects: result.objects ?? [],
              actions: result.actions ?? [],
              // 落库前已归一，这里的兜底只为兼容历史数据
              sceneType: (result.sceneType || 'other') as Vlm.SceneType,
              tags: result.tags ?? [],
            },
          }
        : {}),
      rawText: doc.rawText ?? '',
      modelCalls: doc.modelCalls ?? 0,
      modelId: doc.modelId ?? '',
      elapsedMs: doc.elapsedMs ?? 0,
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

export const vlmService = new VlmService();
