import path from 'node:path';
import crypto from 'node:crypto';
import { isValidObjectId } from 'mongoose';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { Logger } from '../../utils/Logger.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import {
  AI_DETECT_SOURCE_CATEGORY,
  AI_DETECT_URL_MIME_PREFIXES,
  aiDetectStageLabel,
  normalizeDetector,
} from '../../utils/constant/aiDetect.ts';
import { isSupportedVideoMime } from '../../utils/constant/subtitle.ts';
import aiDetectConfig from '../../utils/aiDetect/aiDetect.config.ts';
// 转写复用 subtitle 模块的 ASR 能力，故提交期要读它的总开关（关着就直接 503）
import asrConfig from '../../utils/asr/asr.config.ts';
import {
  assertPublicHttpUrl,
  downloadRemoteMedia,
  guessMediaExt,
} from '../../utils/videoHelper/remoteDownload.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import { vlmBatchService } from '../vlmBatch/vlmBatch.service.ts';
import {
  buildMulterFile,
  nextUploadPath,
  removeFileQuietly,
  sanitizeFileName,
} from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import { aiDetectTaskRepository } from './aiDetectTask.repository.ts';
import { aiDetectFrameTaskRepository } from './aiDetectFrameTask.repository.ts';
import { aiDetectAsrTaskRepository } from './aiDetectAsrTask.repository.ts';
import { aiDetectDispatcher, type AiDetectQueueKind } from './aiDetectDispatcher.ts';
import {
  createDetectChunkSession,
  describeDetectChunkSession,
  mergeDetectChunkSession,
  pruneDetectChunkSessions,
  readDetectChunkSession,
  removeDetectChunkSession,
  resolveDetectChunkInit,
} from './aiDetectChunk.helper.ts';
import { mergeSceneGroups } from './aiDetectMerge.helper.ts';
import type { AiDetectTaskDocument } from './aiDetectTask.entity.ts';
import type { AiDetectFrameTaskDocument } from './aiDetectFrameTask.entity.ts';
import type { AiDetectAsrTaskDocument } from './aiDetectAsrTask.entity.ts';
import type { FileDocument } from '../file/file.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { AiDetect, ChunkUpload, SceneDetect } from '../../type/index.d.ts';

const logger = Logger.getInstance();

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/** 字节数 → Mb 文案（错误提示用） */
const formatMb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MB`;

/** 非法/未指定的检测数值统一落 0，表示「由检测脚本用推荐值兜底」 */
const toOptionalNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** 任务创建入参 */
interface StartTaskInput {
  sourceType: AiDetect.SourceType;
  sourceFileId: string;
  originalName: string;
  remoteUrl?: string;
  userId?: string;
  detector: SceneDetect.Detector;
  threshold: number;
  minSceneLenSec: number;
  downscale: number;
  frameSkip: number;
  /** 首尾黑帧检测窗口时长（秒）；0 = 不做检测 */
  blackDetectSec: number;
}

/**
 * 场景切分服务。
 *
 * 提交只负责「校验 + 登记源视频 + 建任务 + 唤醒调度器」，不在请求链路里跑检测 ——
 * PySceneDetect 是纯 CPU 逐帧分析，长片可达数分钟，因此由 aiDetectDispatcher 异步领取执行，
 * 客户端轮询 GET /scene/tasks/:taskId 取进度。
 *
 * 唯一的例外是 `submitFromUrl`：URL 下载留在请求内完成（与字幕模块「视频提取音频放在提交链路」
 * 同一取舍），这样非法地址/非视频/超限都能当场返回 4xx，而不是让用户拿到 taskId 再轮询发现失败。
 */
class AiDetectService {
  /**
   * 提交场景切分任务（multipart 上传的视频）。
   *
   * 复用 multer 已落盘的文件：类型/体积预检不通过就直接删掉，避免为非法输入白建一条 file 记录。
   */
  async submitFromFile(
    file: Express.Multer.File,
    dto: AiDetect.DetectOptions & { userId?: string } = {},
  ): Promise<ServiceResult<AiDetect.TaskAccepted>> {
    if (!aiDetectConfig.enabled) {
      removeFileQuietly(file.path);
      return this.disabled();
    }

    if (file.size > aiDetectConfig.maxVideoBytes) {
      removeFileQuietly(file.path);
      return {
        error: `视频大小不能超过 ${formatMb(aiDetectConfig.maxVideoBytes)}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }
    if (!isSupportedVideoMime(file.mimetype, file.originalname)) {
      removeFileQuietly(file.path);
      return {
        error: `不支持的视频类型：${file.mimetype || '未知'}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    const userId = dto.userId ?? '';
    /** 是否已登记进 file 表：已登记就不能再删磁盘文件，否则 file 记录会指向不存在的文件 */
    let registered = false;

    try {
      const { created } = await fileService.upload(file, {
        category: AI_DETECT_SOURCE_CATEGORY,
        ...(userId ? { createBy: userId } : {}),
      });
      registered = true;

      const sourceFileId = String(created._id);
      return await this.startTask({
        sourceType: 'upload',
        sourceFileId,
        originalName: file.originalname,
        userId,
        ...this.detectParams(dto),
      });
    } finally {
      if (!registered) removeFileQuietly(file.path);
    }
  }

  /** 提交场景切分任务（引用已有 file 记录） */
  async submitFromFileId(
    fileId: string,
    dto: AiDetect.DetectOptions & { userId?: string } = {},
  ): Promise<ServiceResult<AiDetect.TaskAccepted>> {
    if (!aiDetectConfig.enabled) return this.disabled();

    const id = (fileId ?? '').trim();
    const checked = await this.validateSourceFile(id);
    if ('error' in checked) return checked;

    return this.startTask({
      sourceType: 'fileId',
      sourceFileId: id,
      originalName: checked.file.originalName,
      ...(dto.userId ? { userId: dto.userId } : {}),
      ...this.detectParams(dto),
    });
  }

  /**
   * 提交场景切分任务（远程 URL）。
   *
   * 流程：地址安全校验 → 下载到 uploads → 登记 file 记录 → 建任务。
   * 任何失败分支都会清掉刚下载的文件 —— URL 路径的产物完全由本次请求创建，只有这里知道该清哪条路径。
   */
  async submitFromUrl(
    url: string,
    dto: AiDetect.DetectOptions & { userId?: string } = {},
  ): Promise<ServiceResult<AiDetect.TaskAccepted>> {
    if (!aiDetectConfig.enabled) return this.disabled();

    const rawUrl = (url ?? '').trim();

    // 先做协议 + 地址校验，把内网/非法协议这类明显恶意输入挡在下载之前（错误已是面向用户的文案）
    try {
      await assertPublicHttpUrl(rawUrl);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'URL 校验失败',
        code: HttpStatus.BAD_REQUEST,
      };
    }

    const userId = dto.userId ?? '';
    // 下载上限取「URL 专用上限」与「源视频业务上限」的较小值：避免下回一个注定会被业务拒绝的大文件
    const maxBytes = Math.min(aiDetectConfig.url.maxBytes, aiDetectConfig.maxVideoBytes);

    let destAbs: string | null = null;
    let registered = false;

    try {
      // 扩展名只能按 URL 先猜（此时还没有响应头）；文件名只影响下载体验、不参与解码，不做二次改名
      destAbs = nextUploadPath(fileConfig.uploadDir, guessMediaExt(rawUrl, ''));

      const downloaded = await downloadRemoteMedia(rawUrl, destAbs, {
        maxBytes,
        timeoutMs: aiDetectConfig.url.timeoutMs,
        maxRedirects: aiDetectConfig.url.maxRedirects,
        allowedMimePrefix: AI_DETECT_URL_MIME_PREFIXES,
      });

      const originalName = this.resolveRemoteName(downloaded.finalUrl, path.extname(destAbs));

      // Content-Type 可能是 application/octet-stream（白名单放行），故再按扩展名复核一次，
      // 防止「通用二进制类型 + 非视频后缀」被当成视频送进检测
      if (!isSupportedVideoMime(downloaded.contentType, originalName)) {
        return {
          error: `不支持的视频类型：${downloaded.contentType || '未知'}`,
          code: HttpStatus.BAD_REQUEST,
        };
      }

      const { created } = await fileService.upload(
        buildMulterFile(destAbs, originalName, downloaded.contentType || 'video/mp4'),
        {
          category: AI_DETECT_SOURCE_CATEGORY,
          ...(userId ? { createBy: userId } : {}),
          metadata: { remoteUrl: rawUrl, finalUrl: downloaded.finalUrl },
        },
      );
      registered = true;

      return await this.startTask({
        sourceType: 'url',
        sourceFileId: String(created._id),
        originalName,
        remoteUrl: rawUrl,
        userId,
        ...this.detectParams(dto),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[AiDetect] URL 下载失败 url=${rawUrl}：${message}`);
      return { error: message, code: HttpStatus.BAD_REQUEST };
    } finally {
      // 未登记的临时下载文件必须清掉；已登记的由 file 记录持有，不能删
      if (!registered && destAbs) removeFileQuietly(destAbs);
    }
  }

  // ---- 大文件分片上传 ----
  // 与素材库同口径（utils/chunkUpload/chunkSession.ts）：会话只存磁盘，四个接口分别对应
  // 「建会话 / 传分片（由路由 + 中间件落盘）/ 查进度 / 放弃」，全部到齐后由 submitFromChunk 合并入库。
  // 分片与整份上传共用同一个源视频上限（maxVideoBytes，默认 2.5GB）：分片的意义是断点续传、
  // 不必赌一个 GB 级的长请求，而不是「只有走分片才收得了大文件」。

  /** 初始化分片上传会话：校验声明体量/分片数（resolveDetectChunkInit）→ 建会话目录（顺带清理超期会话） */
  async initChunkUpload(
    dto: ChunkUpload.InitDto,
  ): Promise<{ data: ChunkUpload.Session } | { error: string; code: number }> {
    const resolved = resolveDetectChunkInit(dto, crypto.randomUUID());
    if ('error' in resolved) {
      return { error: resolved.error, code: HttpStatus.BAD_REQUEST };
    }

    // 分片上传没有常驻调度器，趁机回收超期会话，避免放弃的上传永久占盘
    pruneDetectChunkSessions(aiDetectConfig.chunk.sessionTtlMs, (message) =>
      logger.warn(`[AiDetect] 分片会话清理失败：${message}`),
    );

    await createDetectChunkSession(resolved.data);
    return { data: describeDetectChunkSession(resolved.data) };
  }

  /** 查询分片上传进度（断点续传：客户端据此只补传缺失分片） */
  async getChunkUpload(
    uploadId: string,
  ): Promise<{ data: ChunkUpload.Session } | { error: string; code: number }> {
    const meta = readDetectChunkSession(uploadId);
    if (!meta) {
      return { error: '分片上传会话不存在或已过期', code: HttpStatus.NOT_FOUND };
    }
    return { data: describeDetectChunkSession(meta) };
  }

  /** 放弃分片上传：删除会话目录与已收分片 */
  async abortChunkUpload(
    uploadId: string,
  ): Promise<{ data: true } | { error: string; code: number }> {
    const meta = readDetectChunkSession(uploadId);
    if (!meta) {
      return { error: '分片上传会话不存在或已过期', code: HttpStatus.NOT_FOUND };
    }
    removeDetectChunkSession(uploadId);
    return { data: true };
  }

  /**
   * 提交场景切分任务（大文件分片口径）：合并会话全部分片 → 落 file 表 → 建任务。
   *
   * 与 submitFromFile 的差别只在「文件从哪来」，其余流程完全一致：体量上限同取 maxVideoBytes，
   * 分片只是让 GB 级上传能断点续传。缺片/字节数不符时**保留会话**，客户端补齐后直接重试，
   * 不必重传整份文件。
   */
  async submitFromChunk(
    uploadId: string,
    dto: AiDetect.DetectOptions & { userId?: string } = {},
  ): Promise<ServiceResult<AiDetect.TaskAccepted>> {
    if (!aiDetectConfig.enabled) return this.disabled();

    const meta = readDetectChunkSession(uploadId);
    if (!meta) {
      return { error: '分片上传会话不存在或已过期', code: HttpStatus.NOT_FOUND };
    }

    // 落盘路径与 uploadDetectVideo 一致（uploads/Y/M/D/<uuid><ext>），使 fileService 的相对路径推导与静态访问无需特殊处理
    const destAbs = nextUploadPath(fileConfig.uploadDir, path.extname(meta.fileName).toLowerCase());

    try {
      await mergeDetectChunkSession(uploadId, meta, destAbs);
    } catch (err) {
      return { error: err instanceof Error ? err.message : '分片合并失败', code: HttpStatus.BAD_REQUEST };
    }

    // 合并成功，分片使命结束（此后磁盘上只剩合并后的成品）
    removeDetectChunkSession(uploadId);

    const userId = dto.userId ?? '';
    /** 是否已登记进 file 表：已登记就不能再删磁盘文件，否则 file 记录会指向不存在的文件 */
    let registered = false;

    try {
      const { created } = await fileService.upload(
        buildMulterFile(destAbs, meta.fileName, meta.mimeType),
        {
          category: AI_DETECT_SOURCE_CATEGORY,
          ...(userId ? { createBy: userId } : {}),
        },
      );
      registered = true;

      return await this.startTask({
        // 分片合并出来的成品同样是一次「上传」，故仍记为 upload；是否走分片可由 file.size 看出
        sourceType: 'upload',
        sourceFileId: String(created._id),
        originalName: meta.fileName,
        userId,
        ...this.detectParams(dto),
      });
    } finally {
      if (!registered) removeFileQuietly(destAbs);
    }
  }

  // ---- 场景抽帧（依赖已完成的场景切分任务）----
  // 抽帧的产物是图片而不是时间段：对来源场景任务的每个场景抽开始/中间/结束三帧，逐帧登记 file 表
  // （category = aiDetectFrame），便于后续按 fileId 送图片理解（src/vlm/vlm.service.ts 的既有约定）。
  // 与场景切分共用同一张任务表与同一条队列，故同样由 leader dispatcher 异步执行。

  /**
   * 提交抽帧任务（唯一入参：已完成的场景切分任务 id）。
   *
   * 把「能不能抽」全部判在提交期（任务已完成 / 源视频还在 / 没有重复的抽帧任务在跑），
   * 而不是先建任务再异步失败：抽帧可能产出上千张图、跑上数分钟，让用户轮询一轮才发现前提不成立最糟。
   */
  async submitFramesTask(
    sceneTaskId: string,
    dto: { userId?: string } = {},
  ): Promise<ServiceResult<AiDetect.TaskAccepted>> {
    if (!aiDetectConfig.enabled) return this.disabled();

    const id = (sceneTaskId ?? '').trim();
    if (!id || !isValidObjectId(id)) {
      return { error: '非法的场景切分任务 id', code: HttpStatus.BAD_REQUEST };
    }

    // 来源必须是场景切分任务：抽帧任务在自己的集合里，故这里查不到就说明 id 不是场景切分任务
    const sceneTask = await aiDetectTaskRepository.findById(id);
    if (!sceneTask) {
      return { error: '场景切分任务不存在', code: HttpStatus.NOT_FOUND };
    }

    const userId = dto.userId ?? '';
    if (sceneTask.userId !== userId) {
      return { error: '只能对自己提交的场景切分任务抽帧', code: HttpStatus.FORBIDDEN };
    }
    if (sceneTask.status !== 'success' || sceneTask.scenes.length === 0) {
      return { error: '场景切分任务尚未完成，无法抽帧', code: HttpStatus.CONFLICT };
    }

    // 提交时就核一遍源视频：拖到抽帧阶段才发现文件没了，用户只能等任务失败再来一次
    const sourceFile = await fileService.getById(sceneTask.sourceFileId);
    if (!sourceFile || !fileService.fileExistsOnDisk(sourceFile)) {
      return { error: '源视频文件已丢失，请重新提交场景切分任务', code: HttpStatus.CONFLICT };
    }

    if (await aiDetectFrameTaskRepository.existsActiveBySourceTask(id)) {
      return { error: '该场景切分任务已有抽帧任务在排队或执行中', code: HttpStatus.CONFLICT };
    }

    const task = await aiDetectFrameTaskRepository.createFrameTask({
      sourceTaskId: id,
      sourceType: sceneTask.sourceType,
      sourceFileId: sceneTask.sourceFileId,
      sourceUrl: sceneTask.sourceUrl,
      originalName: sceneTask.originalName,
      sceneCount: sceneTask.sceneCount,
      durationMs: sceneTask.durationMs,
      frameRate: sceneTask.frameRate,
      ...(userId ? { userId } : {}),
    });

    aiDetectDispatcher.start();
    return { data: { taskId: String(task._id), status: task.status } };
  }

  /** 查询抽帧任务（带归属校验） */
  async getFrameTask(
    taskId: string,
    userId: string,
  ): Promise<ServiceResult<AiDetect.FrameTaskRecord>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const task = await aiDetectFrameTaskRepository.findById(taskId);
    if (!task) return this.notFound();

    const denied = this.assertOwned(task, userId);
    if (denied) return denied;

    return { data: this.toFrameRecord(task) };
  }

  /** 分页查询当前用户的抽帧任务 */
  async listFrameTasks(
    userId: string,
    query: AiDetect.FrameTaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<AiDetect.FrameTaskRecord>>> {
    const page = await aiDetectFrameTaskRepository.findPageByUser({
      userId,
      ...(query.status ? { status: query.status } : {}),
      page: query.page,
      limit: query.limit,
    });
    return {
      data: {
        list: page.list.map((doc) => this.toFrameRecord(doc)),
        total: page.total,
        page: page.page,
        limit: page.limit,
      },
    };
  }

  /** 取消一条排队中的抽帧任务（仅 pending 可取消，语义与场景切分任务一致） */
  async cancelFrameTask(
    taskId: string,
    userId: string,
  ): Promise<ServiceResult<AiDetect.FrameTaskRecord>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const task = await aiDetectFrameTaskRepository.findById(taskId);
    if (!task) return this.notFound();

    const denied = this.assertOwned(task, userId);
    if (denied) return denied;

    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    // 读取与取消之间被 dispatcher 领取（条件更新与 claimNextPending 互斥）
    const cancelled = await aiDetectFrameTaskRepository.cancelPending(taskId);
    if (!cancelled) return { error: '任务已被调度器领取，无法取消', code: HttpStatus.CONFLICT };

    return { data: this.toFrameRecord(cancelled) };
  }

  // ---- 场景转写（依赖已完成的场景切分任务）----
  // 产物是「按场景归并好的文本段」而不是文件：抽音频 → 复用 subtitle 模块的 Whisper 链路转写 →
  // 把分段文本按场景区间归并成 [{startMs,endMs,text}]，同时给一份按场景归组的。
  // 转写不在本进程内跑（见 aiDetectDispatcher.runAsr），本模块只负责切块、提子任务、轮询、归并。

  /**
   * 提交转写任务（唯一入参：已完成的场景切分任务 id）。
   *
   * 与抽帧同一取舍：把「能不能转」全部判在提交期，而不是建了任务再异步失败 ——
   * 转写要走完整的 Whisper 链路（长片还要切十几块、占 subtitle 队列），代价更高。
   */
  async submitAsrTask(
    sceneTaskId: string,
    dto: { userId?: string } = {},
  ): Promise<ServiceResult<AiDetect.TaskAccepted>> {
    if (!aiDetectConfig.enabled) return this.disabled();
    // 转写跑在 subtitle 模块的队列上：它关着就没必要建任务，否则要等执行时才发现
    if (!asrConfig.enabled) {
      return { error: '语音转写未启用，暂不支持', code: HttpStatus.SERVICE_UNAVAILABLE };
    }

    const id = (sceneTaskId ?? '').trim();
    if (!id || !isValidObjectId(id)) {
      return { error: '非法的场景切分任务 id', code: HttpStatus.BAD_REQUEST };
    }

    const sceneTask = await aiDetectTaskRepository.findById(id);
    if (!sceneTask) {
      return { error: '场景切分任务不存在', code: HttpStatus.NOT_FOUND };
    }

    const userId = dto.userId ?? '';
    if (sceneTask.userId !== userId) {
      return { error: '只能对自己提交的场景切分任务转写', code: HttpStatus.FORBIDDEN };
    }
    if (sceneTask.status !== 'success' || sceneTask.scenes.length === 0) {
      return { error: '场景切分任务尚未完成，无法转写', code: HttpStatus.CONFLICT };
    }

    const sourceFile = await fileService.getById(sceneTask.sourceFileId);
    if (!sourceFile || !fileService.fileExistsOnDisk(sourceFile)) {
      return { error: '源视频文件已丢失，请重新提交场景切分任务', code: HttpStatus.CONFLICT };
    }

    if (await aiDetectAsrTaskRepository.existsActiveBySourceTask(id)) {
      return { error: '该场景切分任务已有转写任务在排队或执行中', code: HttpStatus.CONFLICT };
    }

    const task = await aiDetectAsrTaskRepository.createAsrTask({
      sourceTaskId: id,
      sourceType: sceneTask.sourceType,
      sourceFileId: sceneTask.sourceFileId,
      sourceUrl: sceneTask.sourceUrl,
      originalName: sceneTask.originalName,
      sceneCount: sceneTask.sceneCount,
      durationMs: sceneTask.durationMs,
      ...(userId ? { userId } : {}),
    });

    aiDetectDispatcher.start();
    return { data: { taskId: String(task._id), status: task.status } };
  }

  /** 查询转写任务（带归属校验） */
  async getAsrTask(
    taskId: string,
    userId: string,
  ): Promise<ServiceResult<AiDetect.AsrTaskRecord>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const task = await aiDetectAsrTaskRepository.findById(taskId);
    if (!task) return this.notFound();

    const denied = this.assertOwned(task, userId);
    if (denied) return denied;

    return { data: this.toAsrRecord(task) };
  }

  /** 分页查询当前用户的转写任务 */
  async listAsrTasks(
    userId: string,
    query: AiDetect.AsrTaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<AiDetect.AsrTaskRecord>>> {
    const page = await aiDetectAsrTaskRepository.findPageByUser({
      userId,
      ...(query.status ? { status: query.status } : {}),
      page: query.page,
      limit: query.limit,
    });
    return {
      data: {
        list: page.list.map((doc) => this.toAsrRecord(doc)),
        total: page.total,
        page: page.page,
        limit: page.limit,
      },
    };
  }

  /** 取消一条排队中的转写任务（仅 pending 可取消，语义与另两类任务一致） */
  async cancelAsrTask(
    taskId: string,
    userId: string,
  ): Promise<ServiceResult<AiDetect.AsrTaskRecord>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const task = await aiDetectAsrTaskRepository.findById(taskId);
    if (!task) return this.notFound();

    const denied = this.assertOwned(task, userId);
    if (denied) return denied;

    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    const cancelled = await aiDetectAsrTaskRepository.cancelPending(taskId);
    if (!cancelled) return { error: '任务已被调度器领取，无法取消', code: HttpStatus.CONFLICT };

    return { data: this.toAsrRecord(cancelled) };
  }

  /** 查询场景切分任务（带归属校验） */
  async getTask(taskId: string, userId: string): Promise<ServiceResult<AiDetect.TaskRecord>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const task = await aiDetectTaskRepository.findById(taskId);
    if (!task) return this.notFound();

    const denied = this.assertOwned(task, userId);
    if (denied) return denied;

    const [record] = await this.toRecordsWithSubTasks([task]);
    return record ? { data: record } : this.notFound();
  }

  /** 分页查询当前用户的场景切分任务（内嵌该任务下的抽帧、转写、图像识别任务） */
  async listTasks(
    userId: string,
    query: AiDetect.TaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<AiDetect.TaskRecord>>> {
    const page = await aiDetectTaskRepository.findPageByUser({
      userId,
      ...(query.status ? { status: query.status } : {}),
      page: query.page,
      limit: query.limit,
    });

    return {
      data: {
        list: await this.toRecordsWithSubTasks(page.list),
        total: page.total,
        page: page.page,
        limit: page.limit,
      },
    };
  }

  /**
   * 取消一条排队中的场景切分任务。
   *
   * 仅 status=pending 可取消：取消走仓储的原子条件更新（与 claimNextPending 互斥），
   * 已被领取执行、已完成/失败的任务一律拒绝。
   */
  async cancel(taskId: string, userId: string): Promise<ServiceResult<AiDetect.TaskRecord>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const task = await aiDetectTaskRepository.findById(taskId);
    if (!task) return this.notFound();

    const denied = this.assertOwned(task, userId);
    if (denied) return denied;

    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    const cancelled = await aiDetectTaskRepository.cancelPending(taskId);
    if (!cancelled) {
      return { error: '任务已被调度器领取，无法取消', code: HttpStatus.CONFLICT };
    }
    return { data: this.toRecord(cancelled) };
  }

  // ---- 场景合并（同步接口，写回来源任务）----
  // 与抽帧/转写相反，这里**不入队**：合并只是纯数组计算，请求内即可算出，无需 worker。
  // 但它**会改写来源任务的 scenes**（用户的真实意图就是「这个任务从此按合并后的划分用」），
  // 故这是一次破坏性操作：原划分不保留、不可撤销，且允许反复调用（每次在当前划分上再并）。

  /**
   * 按场景序号分组合并，并把结果写回来源任务（同步实现）。
   *
   * groups 以 unknown 传入：它是嵌套数组，形状与合并规则一并在 helper 里判，
   * controller 保持无脑转发，避免同一条规则散在两个地方各写一半。
   */
  async mergeScenes(
    sceneTaskId: string,
    userId: string,
    groups: unknown,
  ): Promise<ServiceResult<AiDetect.MergedScenesRecord>> {
    const id = (sceneTaskId ?? '').trim();
    if (!id || !isValidObjectId(id)) {
      return { error: '非法的场景切分任务 id', code: HttpStatus.BAD_REQUEST };
    }

    const sceneTask = await aiDetectTaskRepository.findById(id);
    if (!sceneTask) {
      return { error: '场景切分任务不存在', code: HttpStatus.NOT_FOUND };
    }

    const denied = this.assertOwned(sceneTask, userId);
    if (denied) return denied;

    // 合并的前提与抽帧/转写同一口径：必须是已完成、scenes 非空的场景任务
    if (sceneTask.status !== 'success' || sceneTask.scenes.length === 0) {
      return { error: '场景切分任务尚未完成，无法合并', code: HttpStatus.CONFLICT };
    }

    // 有下游任务就拒绝：抽帧/转写的记录里存着按**旧**划分算出的 sceneIndex 与区间
    // （抽帧的 file metadata、转写的 sceneSegments），改写划分会让那些记录指向另一段视频，
    // 而它们已经跑完、不会重算 —— 这种不一致没有事后修复的办法，只能在入口挡住。
    // 注意这是「先查后写」的尽力而为检查，不是锁：与并发的抽帧提交之间仍有极窄的竞态窗口。
    if (await aiDetectFrameTaskRepository.existsBySourceTask(id)) {
      return { error: '该场景切分任务已有抽帧任务，无法再合并场景', code: HttpStatus.CONFLICT };
    }
    if (await aiDetectAsrTaskRepository.existsBySourceTask(id)) {
      return { error: '该场景切分任务已有转写任务，无法再合并场景', code: HttpStatus.CONFLICT };
    }

    const merged = mergeSceneGroups(sceneTask.scenes, groups);
    if ('error' in merged) {
      return { error: merged.error, code: HttpStatus.BAD_REQUEST };
    }

    // 写回：覆盖 scenes 与 sceneCount。拿不到结果说明这条任务在本次请求期间被删除或易主
    const updated = await aiDetectTaskRepository.updateScenes(id, userId, merged.scenes);
    if (!updated) return this.notFound();

    return {
      data: {
        sourceTaskId: id,
        scenes: merged.scenes,
        sceneCount: merged.scenes.length,
        sourceSceneCount: sceneTask.scenes.length,
      },
    };
  }

  /**
   * 查询任务排队位置。口径与 claimNextPending 的领取顺序（createdAt 升序 FIFO）一致。
   * 注意 count 与领取不是原子的：返回的是查询瞬间的快照。
   *
   * 计数与位次都**只看本队列**（kind 决定读哪张表）：场景切分与抽帧是两条独立队列，
   * 各自的排队位次互不影响。
   */
  async getQueuePosition(
    taskId: string,
    userId: string,
    kind: AiDetectQueueKind = 'scene',
  ): Promise<ServiceResult<AiDetect.TaskQueuePosition>> {
    if (!isValidObjectId(taskId)) return this.notFound();

    const repo = this.queueRepo(kind);

    const task = await repo.findById(taskId);
    if (!task) return this.notFound();

    const denied = this.assertOwned(task, userId);
    if (denied) return denied;

    const [queueDepth, running] = await Promise.all([repo.countPending(), repo.countRunning()]);

    let position: number | null = null;
    let waitingAhead = 0;
    if (task.status === 'pending') {
      const before = await repo.countPendingBefore(task.createdAt);
      position = before + 1;
      waitingAhead = before + running;
    }

    return { data: { taskId, status: task.status, position, waitingAhead, queueDepth, running } };
  }

  /** 队列计数（指定队列的全局口径，不针对具体任务、也不要求归属） */
  async getQueueStatus(kind: AiDetectQueueKind): Promise<ServiceResult<AiDetect.QueueStatus>> {
    const repo = this.queueRepo(kind);
    const [pending, running] = await Promise.all([repo.countPending(), repo.countRunning()]);
    return { data: { total: pending + running, pending, running } };
  }

  /**
   * 引擎状态（进程内视角）。
   *
   * 调度器是一个进程管三条队列，故按 kind 各报一份：并发上限、在途数、队列深度、最近进度
   * 都只看本队列 —— 一条队列填满自己的额度不会体现在另一条上。
   */
  async getEngineStatus(kind: AiDetectQueueKind): Promise<ServiceResult<AiDetect.EngineStatus>> {
    const repo = this.queueRepo(kind);
    const queueDepth = await repo.countPending().catch(() => 0);
    return {
      data: {
        workerId: getWorkerId(),
        enabled: aiDetectConfig.enabled,
        leader: aiDetectDispatcher.isLeader(),
        queueDepth,
        concurrency: aiDetectDispatcher.getConcurrency(kind),
        activeCount: aiDetectDispatcher.getActiveCount(kind),
        lastProgress: aiDetectDispatcher.getLastProgress(kind),
      },
    };
  }

  /**
   * 统一的「任务不存在」失败返回。
   *
   * 两条队列的类型隔离是**天然的**：各在自己的集合里，拿抽帧任务 id 调场景接口只会在场景集合里
   * 查不到、直接落到这里 —— 不需要比对任何类型字段，也不会从错误码上泄漏「这个 id 是另一类任务」。
   */
  private notFound(): { error: string; code: number } {
    return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
  }

  /** 归属校验：返回错误对象，或 null 表示通过（两类任务的查询/取消共用） */
  private assertOwned(
    task: { userId: string },
    userId: string,
  ): { error: string; code: number } | null {
    return task.userId === userId
      ? null
      : { error: '只能查看当前用户自己的任务', code: HttpStatus.FORBIDDEN };
  }

  /**
   * 按队列取仓储（三条队列的仓储方法同形，只有落库表与文档类型不同）。
   *
   * 只在本文件里用于「按主键取任务 + 计数」这类对三条队列完全一致的读操作；
   * 需要各自文档类型的地方（toRecord / toFrameRecord / toAsrRecord）按队列显式取仓储。
   */
  private queueRepo(kind: AiDetectQueueKind) {
    if (kind === 'frames') return aiDetectFrameTaskRepository;
    if (kind === 'asr') return aiDetectAsrTaskRepository;
    return aiDetectTaskRepository;
  }

  /** 建任务 + 唤醒调度器（没有 start()，任务会一直躺在 pending 里） */
  private async startTask(input: StartTaskInput): Promise<ServiceResult<AiDetect.TaskAccepted>> {
    const task = await aiDetectTaskRepository.create({
      sourceType: input.sourceType,
      sourceFileId: input.sourceFileId,
      sourceUrl: `/api/files/${input.sourceFileId}/download`,
      originalName: input.originalName,
      ...(input.remoteUrl ? { remoteUrl: input.remoteUrl } : {}),
      detector: input.detector,
      threshold: input.threshold,
      minSceneLenSec: input.minSceneLenSec,
      downscale: input.downscale,
      frameSkip: input.frameSkip,
      blackDetectSec: input.blackDetectSec,
      ...(input.userId ? { userId: input.userId } : {}),
    });

    aiDetectDispatcher.start();
    return { data: { taskId: String(task._id), status: task.status } };
  }

  /** 归一化检测参数：算法名回退到配置缺省，数值非法一律落 0（表示「用脚本推荐值」） */
  private detectParams(dto: AiDetect.DetectOptions): {
    detector: SceneDetect.Detector;
    threshold: number;
    minSceneLenSec: number;
    downscale: number;
    frameSkip: number;
    blackDetectSec: number;
  } {
    return {
      detector: normalizeDetector(dto.detector, aiDetectConfig.defaultDetector),
      threshold: toOptionalNumber(dto.threshold),
      minSceneLenSec: toOptionalNumber(dto.minSceneLenSec),
      downscale: toOptionalNumber(dto.downscale),
      frameSkip: toOptionalNumber(dto.frameSkip),
      // 与其余数值参数同一口径：非正数/NaN 一律落 0，表示「不做首尾黑帧检测」
      blackDetectSec: toOptionalNumber(dto.blackDetectSec),
    };
  }

  /**
   * 源视频校验：id 合法性 → 记录存在 → 磁盘在 → 体积上限 → 视频类型。
   * 提交时即校验，让用户立刻拿到 400/404，而不是等任务跑起来才通过轮询发现。
   */
  private async validateSourceFile(
    fileId: string,
  ): Promise<{ file: FileDocument } | { error: string; code: number }> {
    const id = (fileId ?? '').trim();
    if (!id || !isValidObjectId(id)) {
      return { error: '非法的视频文件 id', code: HttpStatus.BAD_REQUEST };
    }

    const file = await fileService.getById(id);
    if (!file) return { error: '视频文件不存在', code: HttpStatus.NOT_FOUND };
    if (!fileService.fileExistsOnDisk(file)) {
      return { error: '视频文件已丢失，请重新上传', code: HttpStatus.NOT_FOUND };
    }
    if (file.size > aiDetectConfig.maxVideoBytes) {
      return {
        error: `视频大小不能超过 ${formatMb(aiDetectConfig.maxVideoBytes)}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }
    if (!isSupportedVideoMime(file.mimeType, file.originalName)) {
      return {
        error: `不支持的视频类型：${file.mimeType || '未知'}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }
    return { file };
  }

  /** 由最终地址与落盘扩展名推一个安全的原始文件名（避免把 URL 里的 query/路径当文件名） */
  private resolveRemoteName(finalUrl: string, ext: string): string {
    let base = '';
    try {
      base = path.basename(new URL(finalUrl).pathname);
    } catch {
      // URL 解析失败就退回默认名
    }
    const stem = base
      ? sanitizeFileName(path.basename(base, path.extname(base)), 'remote-video')
      : 'remote-video';
    return `${stem}${ext}`;
  }

  /** 开关关闭时的统一响应 */
  private disabled(): ServiceResult<never> {
    return { error: '场景切分未启用，暂不支持', code: HttpStatus.SERVICE_UNAVAILABLE };
  }

  /**
   * 落库文档批量转对外记录，并内嵌各自的下游任务（抽帧 / 转写 / 图像识别）。
   *
   * 分页列表与任务详情共用：一次批量取三类下游任务避免 N+1 —— 抽帧/转写直接挂场景任务；
   * 图像识别挂在抽帧任务下，故按「场景 id → 其抽帧任务 id → 图像识别任务」两跳归集。
   */
  private async toRecordsWithSubTasks(
    docs: AiDetectTaskDocument[],
  ): Promise<AiDetect.TaskRecord[]> {
    const sceneIds = docs.map((doc) => String(doc._id));
    const [frameDocs, asrDocs] = await Promise.all([
      aiDetectFrameTaskRepository.findBySourceTaskIds(sceneIds),
      aiDetectAsrTaskRepository.findBySourceTaskIds(sceneIds),
    ]);
    const imageDocs = await vlmBatchService.listBySourceTaskIds(
      frameDocs.map((doc) => String(doc._id)),
    );

    const framesByScene = groupBy(frameDocs, (doc) => doc.sourceTaskId);
    const asrsByScene = groupBy(asrDocs, (doc) => doc.sourceTaskId);
    const imagesByFrame = groupBy(imageDocs, (doc) => doc.sourceTaskId);

    return docs.map((doc) => {
      const id = String(doc._id);
      const frames = framesByScene.get(id) ?? [];
      return {
        ...this.toRecord(doc),
        frameTasks: frames.map((frame) => this.toFrameRecord(frame)),
        asrTasks: (asrsByScene.get(id) ?? []).map((asr) => this.toAsrRecord(asr)),
        imageTasks: frames.flatMap((frame) => imagesByFrame.get(String(frame._id)) ?? []),
      };
    });
  }

  /** 落库文档 → 对外记录（_id 映射为 id，并附带阶段中文描述） */
  private toRecord(doc: AiDetectTaskDocument): AiDetect.TaskRecord {
    return {
      id: String(doc._id),
      status: doc.status,
      sourceType: doc.sourceType,
      sourceFileId: doc.sourceFileId,
      sourceUrl: doc.sourceUrl,
      originalName: doc.originalName,
      remoteUrl: doc.remoteUrl ?? '',
      detector: doc.detector,
      threshold: doc.threshold,
      minSceneLenSec: doc.minSceneLenSec,
      downscale: doc.downscale,
      frameSkip: doc.frameSkip,
      blackDetectSec: doc.blackDetectSec ?? 0,
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: aiDetectStageLabel(doc.stage),
      message: doc.message,
      sceneCount: doc.sceneCount ?? 0,
      durationMs: doc.durationMs ?? 0,
      frameRate: doc.frameRate ?? 0,
      pySceneDetectVersion: doc.pySceneDetectVersion ?? '',
      scenes: (doc.scenes ?? []).map((scene) => ({
        index: scene.index,
        startMs: scene.startMs,
        endMs: scene.endMs,
        durationMs: scene.durationMs,
      })),
      blackRanges: (doc.blackRanges ?? []).map((mark) => ({
        position: mark.position,
        sceneIndex: mark.sceneIndex,
        startMs: mark.startMs,
        endMs: mark.endMs,
        durationMs: mark.durationMs,
      })),
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  /** 落库文档 → 抽帧任务对外记录 */
  private toFrameRecord(doc: AiDetectFrameTaskDocument): AiDetect.FrameTaskRecord {
    return {
      id: String(doc._id),
      status: doc.status,
      sourceTaskId: doc.sourceTaskId ?? '',
      sourceFileId: doc.sourceFileId,
      sourceUrl: doc.sourceUrl,
      originalName: doc.originalName,
      sceneCount: doc.sceneCount ?? 0,
      durationMs: doc.durationMs ?? 0,
      frameRate: doc.frameRate ?? 0,
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: aiDetectStageLabel(doc.stage),
      message: doc.message,
      frameCount: doc.frameCount ?? 0,
      frames: (doc.frameScenes ?? []).map((scene) => ({
        index: scene.index,
        startMs: scene.startMs,
        endMs: scene.endMs,
        frames: (scene.frames ?? []).map((frame) => ({
          kind: frame.kind,
          timeMs: frame.timeMs,
          fileId: frame.fileId,
          url: frame.url,
        })),
      })),
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  /** 落库文档 → 转写任务对外记录 */
  private toAsrRecord(doc: AiDetectAsrTaskDocument): AiDetect.AsrTaskRecord {
    return {
      id: String(doc._id),
      status: doc.status,
      sourceTaskId: doc.sourceTaskId ?? '',
      sourceFileId: doc.sourceFileId,
      sourceUrl: doc.sourceUrl,
      originalName: doc.originalName,
      sceneCount: doc.sceneCount ?? 0,
      durationMs: doc.durationMs ?? 0,
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: aiDetectStageLabel(doc.stage),
      message: doc.message,
      provider: doc.provider ?? '',
      segmentCount: doc.segmentCount ?? 0,
      segments: (doc.segments ?? []).map((segment) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
      })),
      sceneSegments: (doc.sceneSegments ?? []).map((scene) => ({
        index: scene.index,
        startMs: scene.startMs,
        endMs: scene.endMs,
        segments: (scene.segments ?? []).map((segment) => ({
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
        })),
      })),
      chunks: (doc.chunks ?? []).map((chunk) => ({
        index: chunk.index,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        wavFileId: chunk.wavFileId,
        wavUrl: chunk.wavUrl,
        subtitleTaskId: chunk.subtitleTaskId,
        cueCount: chunk.cueCount ?? 0,
      })),
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

/** 按 key 把记录分组，保持原数组顺序（列表内嵌子任务用） */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

export const aiDetectService = new AiDetectService();
