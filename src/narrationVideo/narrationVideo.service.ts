import { isValidObjectId } from 'mongoose';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { DEFAULT_SPEED_MODE, SYNTHESIS_SPEED_MODES } from '../../utils/constant/indextts.ts';
import { narrationVideoStageLabel } from '../../utils/constant/narrationVideo.ts';
import indexttsConfig from '../../utils/indextts/indextts.config.ts';
import narrationVideoConfig from '../../utils/narrationVideo/narrationVideo.config.ts';
import { fileService } from '../file/file.service.ts';
import { aiDetectTaskRepository } from '../aiDetect/aiDetectTask.repository.ts';
import { voiceTrainV2VoiceService } from '../voiceTrainV2/voiceTrainV2Voice.service.ts';
import { narrationVideoTaskRepository } from './narrationVideoTask.repository.ts';
import { narrationVideoDispatcher } from './narrationVideoDispatcher.ts';
import { normalizeNarration } from './narrationVideoBuild.helper.ts';
import type { NarrationVideoTaskDocument } from './narrationVideoTask.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { NarrationVideo } from '../../type/index.d.ts';

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/**
 * 解说视频服务。
 *
 * 提交只负责「校验 + 建任务 + 唤醒调度器」，不在请求链路里执行管道 —— 一次任务包含 N 段 IndexTTS
 * 配音（每段数秒到数分钟）、多次 ffmpeg 裁剪/拼接与最终烧录，由 narrationVideoDispatcher 异步领取
 * 执行，客户端轮询 GET /tasks/:taskId 取进度。
 *
 * 配音复用 voiceTrainV2 / IndexTTS 子任务链路，本服务不直接触达 GPU 引擎。
 */
class NarrationVideoService {
  /**
   * 提交解说视频任务。
   *
   * 提交时即校验开关、来源场景任务、音色归属、解说数据合法性：让用户立刻拿到 400/403/404/409/503，
   * 而不是等任务跑起来才通过轮询发现。
   */
  async submit(dto: NarrationVideo.SubmitTaskDto): Promise<ServiceResult<NarrationVideo.TaskAccepted>> {
    if (!narrationVideoConfig.enabled) {
      return { error: '解说视频未启用，暂不支持', code: HttpStatus.SERVICE_UNAVAILABLE };
    }
    if (!indexttsConfig.enabled) {
      return { error: 'IndexTTS 引擎未启用，暂不支持在线配音', code: HttpStatus.SERVICE_UNAVAILABLE };
    }

    // ---- 来源场景切分任务 → 源视频 ----
    const sceneTaskId = (dto.sceneTaskId ?? '').trim();
    if (!sceneTaskId || !isValidObjectId(sceneTaskId)) {
      return { error: '非法的场景切分任务 id', code: HttpStatus.BAD_REQUEST };
    }
    const sceneTask = await aiDetectTaskRepository.findById(sceneTaskId);
    if (!sceneTask) {
      return { error: '场景切分任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (sceneTask.status !== 'success' || sceneTask.sceneCount === 0) {
      return { error: '场景切分任务尚未完成，无法制作解说视频', code: HttpStatus.CONFLICT };
    }
    const sourceFile = await fileService.getById(sceneTask.sourceFileId);
    if (!sourceFile) {
      return { error: '源视频文件不存在', code: HttpStatus.NOT_FOUND };
    }
    if (!fileService.fileExistsOnDisk(sourceFile)) {
      return { error: '源视频文件已丢失，请重新提交场景切分任务', code: HttpStatus.CONFLICT };
    }

    // ---- 音色 ----
    const voiceId = (dto.voiceId ?? '').trim();
    if (!voiceId || !isValidObjectId(voiceId)) {
      return { error: '非法的 voiceId 参数', code: HttpStatus.BAD_REQUEST };
    }
    const userId = dto.userId ?? '';
    const voice = await voiceTrainV2VoiceService.resolveReference(voiceId, userId);
    if ('error' in voice) {
      return { error: voice.error, code: voice.code };
    }

    // ---- 速度档位 ----
    const speedMode = (dto.speedMode ?? DEFAULT_SPEED_MODE) as string;
    if (!(SYNTHESIS_SPEED_MODES as readonly string[]).includes(speedMode)) {
      return {
        error: `不支持的速度档位「${speedMode}」，可选：${SYNTHESIS_SPEED_MODES.join(' / ')}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    // ---- 解说数据归一化 ----
    const normalized = normalizeNarration(
      dto.narration as unknown,
      sceneTask.durationMs ?? 0,
      indexttsConfig.maxTextChars,
    );
    if ('error' in normalized) {
      return { error: normalized.error, code: HttpStatus.BAD_REQUEST };
    }

    const task = await narrationVideoTaskRepository.create({
      sceneTaskId,
      sourceFileId: sceneTask.sourceFileId,
      sourceUrl: sceneTask.sourceUrl || `/api/files/${sceneTask.sourceFileId}/download`,
      sourceOriginalName: sceneTask.originalName,
      sourceDurationMs: sceneTask.durationMs ?? 0,
      title: normalized.title,
      summary: normalized.summary,
      segments: normalized.segments,
      voiceId,
      speedMode,
      ...(userId ? { userId } : {}),
    });

    // 懒启动调度器：没有这个调用，任务会一直躺在 pending 里
    narrationVideoDispatcher.start();

    return { data: { taskId: String(task._id), status: task.status } };
  }

  /** 查询任务（带归属校验） */
  async getTask(taskId: string, userId: string): Promise<ServiceResult<NarrationVideo.TaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await narrationVideoTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的解说视频任务', code: HttpStatus.FORBIDDEN };
    }
    return { data: this.toRecord(task) };
  }

  /**
   * 取消一条排队中的任务。
   *
   * 仅 status=pending 可取消：取消走仓储的原子条件更新（与 claimNextPending 互斥），
   * 已被领取执行、已完成/失败的任务一律拒绝。
   */
  async cancel(taskId: string, userId: string): Promise<ServiceResult<NarrationVideo.TaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await narrationVideoTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能取消当前用户自己的解说视频任务', code: HttpStatus.FORBIDDEN };
    }
    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    const cancelled = await narrationVideoTaskRepository.cancelPending(taskId);
    if (!cancelled) {
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
  ): Promise<ServiceResult<NarrationVideo.TaskQueuePosition>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await narrationVideoTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的解说视频任务', code: HttpStatus.FORBIDDEN };
    }

    const [queueDepth, running] = await Promise.all([
      narrationVideoTaskRepository.countPending(),
      narrationVideoTaskRepository.countRunning(),
    ]);

    let position: number | null = null;
    let waitingAhead = 0;
    if (task.status === 'pending') {
      const before = await narrationVideoTaskRepository.countPendingBefore(task.createdAt);
      position = before + 1;
      waitingAhead = before + running;
    }

    return { data: { taskId, status: task.status, position, waitingAhead, queueDepth, running } };
  }

  /** 队列计数（全局口径，不针对具体任务、也不要求归属） */
  async getQueueStatus(): Promise<ServiceResult<NarrationVideo.QueueStatus>> {
    const [pending, running] = await Promise.all([
      narrationVideoTaskRepository.countPending(),
      narrationVideoTaskRepository.countRunning(),
    ]);
    return { data: { total: pending + running, pending, running } };
  }

  /**
   * 引擎状态（进程内视角）。本模块不持有模型，配音由 voiceTrainV2 的 leader dispatcher 执行；
   * 这里只报告通道开关、队列深度与本调度器状态。
   */
  async getEngineStatus(): Promise<ServiceResult<NarrationVideo.EngineStatus>> {
    const queueDepth = await narrationVideoTaskRepository.countPending().catch(() => 0);
    return {
      data: {
        workerId: getWorkerId(),
        enabled: narrationVideoConfig.enabled,
        leader: narrationVideoDispatcher.isLeader(),
        voice: { enabled: indexttsConfig.enabled, mode: indexttsConfig.mode },
        queueDepth,
        concurrency: narrationVideoDispatcher.getConcurrency(),
        activeCount: narrationVideoDispatcher.getActiveCount(),
      },
    };
  }

  /** 分页查询当前用户的任务 */
  async listTasks(
    userId: string,
    query: NarrationVideo.TaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<NarrationVideo.TaskRecord>>> {
    const page = await narrationVideoTaskRepository.findPageByUser({
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

  /** 落库文档 → 对外记录（_id 映射为 id，并附带阶段中文描述） */
  private toRecord(doc: NarrationVideoTaskDocument): NarrationVideo.TaskRecord {
    return {
      id: String(doc._id),
      status: doc.status,
      sceneTaskId: doc.sceneTaskId ?? '',
      sourceFileId: doc.sourceFileId,
      sourceUrl: doc.sourceUrl ?? '',
      sourceOriginalName: doc.sourceOriginalName ?? '',
      sourceDurationMs: doc.sourceDurationMs ?? 0,
      title: doc.title ?? '',
      summary: doc.summary ?? '',
      segments: (doc.segments ?? []).map((segment) => ({
        index: segment.index,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        emotion: segment.emotion ?? '',
        clips: (segment.clips ?? []).map((clip) => ({
          startMs: clip.startMs,
          endMs: clip.endMs,
          description: clip.description ?? '',
        })),
      })),
      voiceId: doc.voiceId,
      speedMode: doc.speedMode,
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: narrationVideoStageLabel(doc.stage),
      message: doc.message,
      segmentStates: (doc.segmentStates ?? []).map((state) => ({
        index: state.index,
        voiceTaskId: state.voiceTaskId ?? '',
        audioFileId: state.audioFileId ?? '',
        audioUrl: state.audioUrl ?? '',
        audioDurationMs: state.audioDurationMs ?? 0,
      })),
      srtFileId: doc.srtFileId ?? '',
      srtUrl: doc.srtUrl ?? '',
      cueCount: doc.cueCount ?? 0,
      videoFileId: doc.videoFileId ?? '',
      videoUrl: doc.videoUrl ?? '',
      videoDuration: doc.videoDuration ?? 0,
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

export const narrationVideoService = new NarrationVideoService();
