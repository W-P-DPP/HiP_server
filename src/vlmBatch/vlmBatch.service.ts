import { isValidObjectId } from 'mongoose';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { VLM_BATCH_SOURCE_TYPE, vlmBatchStageLabel } from '../../utils/constant/vlmBatch.ts';
import { buildJsonPrompt, normalizeMode } from '../../utils/constant/vlm.ts';
import vlmConfig, { defaultPromptFor } from '../../utils/vlm/vlm.config.ts';
import vlmBatchConfig from '../../utils/vlm/vlmBatch.config.ts';
import { getVlmClient } from '../../utils/vlm/VlmHttpClient.ts';
import { aiDetectFrameTaskRepository } from '../aiDetect/aiDetectFrameTask.repository.ts';
import { flattenFrameItems } from './vlmBatch.helper.ts';
import { vlmBatchTaskRepository } from './vlmBatchTask.repository.ts';
import { vlmBatchDispatcher } from './vlmBatchDispatcher.ts';
import type { VlmBatchTaskDocument } from './vlmBatchTask.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { Vlm, VlmBatch } from '../../type/index.d.ts';

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/**
 * 批量图像识别服务。
 *
 * 提交只负责「校验 + 解析来源抽帧任务 + 展平关键帧 + 建任务 + 唤醒调度器」，不在请求链路里跑推理
 * —— 一个批次要串行识别成百上千张关键帧，由 vlmBatchDispatcher 异步领取执行，
 * 客户端轮询 GET /tasks/:taskId 取整批进度与逐项结果。
 */
class VlmBatchService {
  /**
   * 提交批量识别任务（唯一必需入参：已完成的抽帧任务 id）。
   *
   * 把「能不能跑」全部判在提交期（任务已完成 / 有帧可取 / 没有重复批次在跑 / 容器已配置），
   * 而不是先建任务再异步失败 —— 一个批次代价高、耗时长，让用户轮询一轮才发现前提不成立最糟。
   */
  async submitFromFramesTask(
    framesTaskId: string,
    dto: VlmBatch.SubmitTaskDto,
  ): Promise<ServiceResult<VlmBatch.TaskAccepted>> {
    if (!vlmBatchConfig.enabled) return this.disabled();
    if (!vlmConfig.configured) return this.unconfigured();

    const id = (framesTaskId ?? '').trim();
    if (!id || !isValidObjectId(id)) {
      return { error: '非法的抽帧任务 id', code: HttpStatus.BAD_REQUEST };
    }

    // 来源必须是抽帧任务：批量任务在自己的集合里，故查不到就说明 id 不是抽帧任务
    const framesTask = await aiDetectFrameTaskRepository.findById(id);
    if (!framesTask) {
      return { error: '抽帧任务不存在', code: HttpStatus.NOT_FOUND };
    }

    const userId = dto.userId ?? '';
    if (framesTask.userId !== userId) {
      return { error: '只能对自己提交的抽帧任务做批量识别', code: HttpStatus.FORBIDDEN };
    }
    if (framesTask.status !== 'success' || (framesTask.frameCount ?? 0) === 0) {
      return { error: '抽帧任务尚未完成，无法批量识别', code: HttpStatus.CONFLICT };
    }

    if (await vlmBatchTaskRepository.existsActiveBySourceTask(id)) {
      return { error: '该抽帧任务已有批量识别任务在排队或执行中', code: HttpStatus.CONFLICT };
    }

    const items = flattenFrameItems(framesTask.frameScenes);
    if (items.length === 0) {
      return { error: '抽帧任务没有可识别的关键帧', code: HttpStatus.CONFLICT };
    }

    const mode = normalizeMode(dto.mode);
    const task = await vlmBatchTaskRepository.create({
      sourceType: VLM_BATCH_SOURCE_TYPE,
      sourceTaskId: id,
      sourceFileId: framesTask.sourceFileId,
      sourceUrl: framesTask.sourceUrl,
      originalName: framesTask.originalName,
      prompt: this.resolvePrompt(mode, dto.prompt),
      mode,
      total: items.length,
      items,
      ...(userId ? { userId } : {}),
    });

    vlmBatchDispatcher.start();
    return {
      data: { taskId: String(task._id), mode, status: task.status, total: items.length },
    };
  }

  /** 查询任务（带归属校验） */
  async getTask(taskId: string, userId: string): Promise<ServiceResult<VlmBatch.TaskRecord>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const task = await vlmBatchTaskRepository.findById(taskId);
    if (!task) return this.notFound();
    if (task.userId !== userId) return this.denied();

    return { data: this.toRecord(task) };
  }

  /** 分页查询当前用户的任务 */
  async listTasks(
    userId: string,
    query: VlmBatch.TaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<VlmBatch.TaskRecord>>> {
    const page = await vlmBatchTaskRepository.findPageByUser({
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

  /** 按来源抽帧任务 id 批量取图像识别任务记录（不分页，供场景任务列表内嵌） */
  async listBySourceTaskIds(sourceTaskIds: string[]): Promise<VlmBatch.TaskRecord[]> {
    const docs = await vlmBatchTaskRepository.findBySourceTaskIds(sourceTaskIds);
    return docs.map((doc) => this.toRecord(doc));
  }

  /**
   * 取消一条排队中的任务。
   *
   * 仅 status=pending 可取消：取消走仓储的原子条件更新（与 claimNextPending 互斥），
   * 已被领取执行、已完成/失败的任务一律拒绝。
   */
  async cancel(taskId: string, userId: string): Promise<ServiceResult<VlmBatch.TaskRecord>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const task = await vlmBatchTaskRepository.findById(taskId);
    if (!task) return this.notFound();
    if (task.userId !== userId) return this.denied();

    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    const cancelled = await vlmBatchTaskRepository.cancelPending(taskId);
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
  ): Promise<ServiceResult<VlmBatch.QueuePosition>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const task = await vlmBatchTaskRepository.findById(taskId);
    if (!task) return this.notFound();
    if (task.userId !== userId) return this.denied();

    const [queueDepth, running] = await Promise.all([
      vlmBatchTaskRepository.countPending(),
      vlmBatchTaskRepository.countRunning(),
    ]);

    let position: number | null = null;
    let waitingAhead = 0;
    if (task.status === 'pending') {
      const before = await vlmBatchTaskRepository.countPendingBefore(task.createdAt);
      position = before + 1;
      waitingAhead = before + running;
    }

    return { data: { taskId, status: task.status, position, waitingAhead, queueDepth, running } };
  }

  /** 队列计数（全局口径，不针对具体任务、也不要求归属） */
  async getQueueStatus(): Promise<ServiceResult<VlmBatch.QueueStatus>> {
    const [pending, running] = await Promise.all([
      vlmBatchTaskRepository.countPending(),
      vlmBatchTaskRepository.countRunning(),
    ]);
    return { data: { total: pending + running, pending, running } };
  }

  /**
   * 引擎状态（进程内视角）。
   *
   * `reachable` 语义与单图队列完全一致：是「容器侧模型在位」而非「服务可用」—— 容器默认懒加载
   * + 空闲卸载，未用过或已卸载时它就是 false，而第一个任务会自动把它拉起来。
   */
  async getEngineStatus(): Promise<ServiceResult<VlmBatch.EngineStatus>> {
    const queueDepth = await vlmBatchTaskRepository.countPending().catch(() => 0);
    const reachable = vlmConfig.configured ? await getVlmClient().ready() : false;

    return {
      data: {
        workerId: getWorkerId(),
        enabled: vlmBatchConfig.enabled,
        configured: vlmConfig.configured,
        reachable,
        leader: vlmBatchDispatcher.isLeader(),
        baseUrl: vlmConfig.baseUrl,
        queueDepth,
        concurrency: vlmBatchDispatcher.getConcurrency(),
        activeCount: vlmBatchDispatcher.getActiveCount(),
        lastProgress: vlmBatchDispatcher.getLastProgress(),
      },
    };
  }

  /**
   * 归一化整批指令。
   *
   * 与单图任务同策略（`vlm.service.ts` 的 resolvePrompt）：json 模式下自定义 prompt 只作为
   * 「description 的内容要求」并入输出信封，不决定输出结构；text 模式下它就是整段输出的要求。
   * 落库而非只在执行时算 —— 换个默认措辞后，旧任务仍能说清当初用的是哪句。
   */
  private resolvePrompt(mode: Vlm.Mode, prompt?: string): string {
    const given = (prompt ?? '').trim();
    if (mode === 'text') return given || defaultPromptFor('text');
    if (!given) return defaultPromptFor('json');
    return buildJsonPrompt(given);
  }

  /** 统一的「任务不存在」失败返回 */
  private notFound(): { error: string; code: number } {
    return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
  }

  /** 归属不符的失败返回 */
  private denied(): { error: string; code: number } {
    return { error: '只能查看当前用户自己的批量识别任务', code: HttpStatus.FORBIDDEN };
  }

  /** 开关关闭时的统一响应 */
  private disabled(): ServiceResult<never> {
    return { error: '批量图像识别未启用，暂不支持', code: HttpStatus.SERVICE_UNAVAILABLE };
  }

  /**
   * 客户端未配置时的统一响应。
   *
   * 与单图任务同一取舍：刻意在**提交**就拦掉，而不是收下任务让它在执行时失败 ——
   * 收下只能给用户一个 taskId，他要轮询一次才知道「根本没接容器」。
   */
  private unconfigured(): ServiceResult<never> {
    return {
      error: '图片理解服务未配置（需 VLM_MODE=remote 且设置 VLM_BASE_URL）',
      code: HttpStatus.SERVICE_UNAVAILABLE,
    };
  }

  /** 落库文档 → 对外记录（_id 映射为 id，并附带阶段中文描述与逐项结果） */
  private toRecord(doc: VlmBatchTaskDocument): VlmBatch.TaskRecord {
    return {
      id: String(doc._id),
      status: doc.status,
      sourceType: doc.sourceType,
      sourceTaskId: doc.sourceTaskId,
      sourceFileId: doc.sourceFileId,
      sourceUrl: doc.sourceUrl,
      originalName: doc.originalName,
      prompt: doc.prompt,
      mode: doc.mode,
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: vlmBatchStageLabel(doc.stage),
      message: doc.message,
      total: doc.total ?? 0,
      succeeded: doc.succeeded ?? 0,
      failed: doc.failed ?? 0,
      items: (doc.items ?? []).map((item) => {
        const result = item.result;
        return {
          index: item.index,
          sceneIndex: item.sceneIndex,
          frameKind: item.frameKind,
          timeMs: item.timeMs,
          fileId: item.fileId,
          url: item.url,
          status: item.status,
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
          rawText: item.rawText ?? '',
          message: item.message ?? '',
          modelCalls: item.modelCalls ?? 0,
          modelId: item.modelId ?? '',
          elapsedMs: item.elapsedMs ?? 0,
        };
      }),
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

export const vlmBatchService = new VlmBatchService();
