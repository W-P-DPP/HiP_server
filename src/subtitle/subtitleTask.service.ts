import fs from 'node:fs';
import { isValidObjectId } from 'mongoose';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { Logger } from '../../utils/Logger.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import {
  isSupportedAudioMime,
  isSupportedVideoMime,
  resolveSubtitleMediaType,
  SUBTITLE_NO_AUDIO_MESSAGE,
  SUBTITLE_SOURCE_CATEGORY,
  SUBTITLE_VIDEO_SOURCE_CATEGORY,
  subtitleStageLabel,
} from '../../utils/constant/subtitle.ts';
import asrConfig from '../../utils/asr/asr.config.ts';
import whisperConfig from '../../utils/whisper/whisper.config.ts';
import { getWhisperClient } from '../../utils/whisper/WhisperHttpClient.ts';
import { extractAudioToWav } from '../../utils/videoHelper/extractAudio.ts';
import { probeDurationSec } from '../../utils/videoHelper/probe.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import { removeFileQuietly } from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import {
  describeExtractFailure,
  newExtractedAudioPath,
  removeExtractedAudio,
} from './subtitleVideo.helper.ts';
import { subtitleTaskRepository } from './subtitleTask.repository.ts';
import { subtitleDispatcher } from './subtitleDispatcher.ts';
import type { SubtitleSourceMediaType, SubtitleTaskDocument } from './subtitleTask.entity.ts';
import type { FileDocument } from '../file/file.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { Subtitle } from '../../type/index.d.ts';

const logger = Logger.getInstance();

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/**
 * 字幕生成服务。
 *
 * 提交只负责「校验 + 建任务 + 唤醒调度器」，不在请求链路里执行转写 —— 一次转写包含
 * 上传 + 轮询讯飞订单（分钟级），所以由 subtitleDispatcher 异步领取执行，
 * 客户端轮询 GET /tasks/:taskId 取进度。
 */
class SubtitleTaskService {
  /**
   * 提交字幕任务（上传/引用音频）。
   *
   * 提交时即校验源文件存在性、大小与类型：让用户立刻拿到 400/404，
   * 而不是等任务跑起来才通过轮询发现。
   */
  async submit(dto: Subtitle.SubmitTaskDto): Promise<ServiceResult<Subtitle.TaskAccepted>> {
    if (!asrConfig.enabled) {
      return { error: '字幕生成未启用，暂不支持', code: HttpStatus.SERVICE_UNAVAILABLE };
    }

    const fileId = (dto.fileId ?? '').trim();
    const checked = await this.validateSourceFile(fileId, 'audio');
    if ('error' in checked) return checked;

    const userId = dto.userId ?? '';
    const task = await subtitleTaskRepository.create({
      sourceType: dto.sourceType,
      sourceMediaType: 'audio',
      audioFileId: fileId,
      audioUrl: `/api/files/${fileId}/download`,
      originalName: checked.file.originalName,
      language: (dto.language ?? '').trim() || asrConfig.language,
      ...(userId ? { userId } : {}),
    });

    // 懒启动调度器：没有这个调用，任务会一直躺在 pending 里
    subtitleDispatcher.start();

    return { data: { taskId: String(task._id), status: task.status } };
  }

  /**
   * 提交媒体字幕任务：**音频直接用，视频先提取音频**，再建 pending 任务。
   *
   * 与 submit 的分工：submit 收的是「已经登记过的音频 file 记录（含 fileId 引用）」，
   * 本方法收的是「当场 multipart 上传的音频或视频」—— 视频多一道 ffmpeg 提取。
   *
   * 为什么提取放在提交链路（而非 dispatcher）里：视频非法/无音轨能在请求内直接 400，
   * 用户不必先拿到 taskId 再轮询发现失败。代价是视频请求会等一次音频解码 —— 只解音轨（-vn，
   * 不解视频帧）故很轻，但大文件仍会比纯音频提交慢。
   *
   * 整条编排（提取 → 登记源文件 → 校验 → 建任务）都留在 service：提取产物是本次请求独有的
   * 临时资源（落 extractedAudioPath），只有创建方知道该清哪条路径，散到 controller 会变成
   * 「谁负责清理」的责任模糊。任何失败分支都会清掉自己创建的临时音频。
   */
  async submitFromMediaFile(
    file: Express.Multer.File,
    dto: { language?: string; userId?: string } = {},
  ): Promise<ServiceResult<Subtitle.TaskAccepted>> {
    if (!asrConfig.enabled) {
      return { error: '字幕生成未启用，暂不支持', code: HttpStatus.SERVICE_UNAVAILABLE };
    }

    // 先用纯内存校验挡掉明显非法的输入，避免白跑一次 ffmpeg、也不产临时目录。
    // 媒体类型判定放在体积之前：体积上限按类型取值，类型都不确定时无从判断该用哪条上限。
    const mediaType = resolveSubtitleMediaType(file.mimetype, file.originalname);
    if (!mediaType) {
      removeFileQuietly(file.path);
      return { error: `不支持的文件类型：${file.mimetype || '未知'}`, code: HttpStatus.BAD_REQUEST };
    }

    const maxBytes = mediaType === 'video' ? asrConfig.maxVideoBytes : asrConfig.maxAudioBytes;
    if (file.size > maxBytes) {
      removeFileQuietly(file.path);
      const maxMb = Math.round(maxBytes / (1024 * 1024));
      return {
        error: `${mediaType === 'video' ? '视频' : '音频'}大小不能超过 ${maxMb}MB`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    /** 仅视频需要提取；音频本身就是 ASR 的输入，落 null 表示「不产临时产物」 */
    const extracted = mediaType === 'video' ? newExtractedAudioPath(fileConfig.uploadDir) : null;
    let success = false;
    /** 源文件是否已登记进 file 表：已登记就不能再删磁盘文件，否则 file 记录会指向不存在的文件 */
    let sourceRegistered = false;

    try {
      if (extracted) {
        try {
          await extractAudioToWav(file.path, extracted.abs);
        } catch (err) {
          // 原始 stderr 只进日志：里面带内部绝对路径与容器细节，不适合回给客户端
          const raw = err instanceof Error ? err.message : String(err);
          logger.error(`[Subtitle] 视频提取音频失败：${raw}`);
          return { error: describeExtractFailure(raw), code: HttpStatus.BAD_REQUEST };
        }

        // 无音轨的视频 ffmpeg 本身就会非 0 退出（已被上面拦下），这里再兜一道时长检查：
        // 防止「文件已生成但 0 秒」的产物被当成有效音频送去转写（转写按量计费，也可能直接失败）。
        const duration = await probeDurationSec(extracted.abs).catch(() => 0);
        if (duration <= 0) {
          logger.error('[Subtitle] 视频提取出的音频时长为 0，判定为无可用音轨');
          return { error: SUBTITLE_NO_AUDIO_MESSAGE, code: HttpStatus.BAD_REQUEST };
        }
      }

      // 源文件与老接口同口径登记进 file 表（视频按类型分到 subtitleVideoSource）：
      // 既保留可回溯/可下载的原始素材，也让 dispatcher 在临时音频被清掉时能从源视频兜底重提
      // （见 subtitleDispatcher.execute）。
      const { created } = await fileService.upload(file, {
        category: extracted ? SUBTITLE_VIDEO_SOURCE_CATEGORY : SUBTITLE_SOURCE_CATEGORY,
        ...(dto.userId ? { createBy: dto.userId } : {}),
      });
      sourceRegistered = true;
      const sourceFileId = String(created._id);

      // 视频按视频口径、音频按音频口径（分别是 ASR_MAX_VIDEO_BYTES / ASR_MAX_AUDIO_BYTES 与对应 MIME）
      const validated = await this.validateSourceFile(sourceFileId, mediaType);
      if ('error' in validated) return validated;

      // 临时音频必须此刻在盘上：不在就说明产物被外部清掉了，在提交链路里 fail-fast，
      // 比让任务跑起来再报「文件已丢失」清楚得多。
      if (extracted && !fs.existsSync(extracted.abs)) {
        return { error: '视频提取的音频已丢失，请重新提交', code: HttpStatus.ERROR };
      }

      const userId = dto.userId ?? '';
      const task = await subtitleTaskRepository.create({
        sourceType: 'upload',
        sourceMediaType: mediaType,
        audioFileId: sourceFileId,
        audioUrl: `/api/files/${sourceFileId}/download`,
        originalName: file.originalname,
        language: (dto.language ?? '').trim() || asrConfig.language,
        ...(extracted ? { extractedAudioPath: extracted.rel } : {}),
        ...(userId ? { userId } : {}),
      });

      // 与 submit 同一语义：没有这个调用，任务会一直躺在 pending 里
      subtitleDispatcher.start();

      success = true;
      return { data: { taskId: String(task._id), status: task.status } };
    } finally {
      if (!success) {
        if (extracted) {
          removeExtractedAudio(fileConfig.uploadDir, extracted.rel, msg =>
            logger.warn(`[Subtitle] 清理临时音频失败（${extracted.rel}）：${msg}`),
          );
        }
        if (!sourceRegistered) removeFileQuietly(file.path);
      }
    }
  }

  /**
   * 提交时的源媒体校验：id 合法性 → 记录存在 → 磁盘在 → 大小 → 类型。
   *
   * 前三条两种媒体共用，后两条按 mediaType 取不同口径
   * （音频 ASR_MAX_AUDIO_BYTES / isSupportedAudioMime，视频 ASR_MAX_VIDEO_BYTES / isSupportedVideoMime）。
   * 错误文案按媒体类型加前缀，其中音频口径与改造前逐字一致。
   */
  private async validateSourceFile(
    fileId: string,
    mediaType: SubtitleSourceMediaType,
  ): Promise<{ file: FileDocument } | { error: string; code: number }> {
    const label = mediaType === 'video' ? '视频' : '音频';

    const id = (fileId ?? '').trim();
    if (!id || !isValidObjectId(id)) {
      return { error: `非法的${label}文件 id`, code: HttpStatus.BAD_REQUEST };
    }

    const file = await fileService.getById(id);
    if (!file) {
      return { error: `${label}文件不存在`, code: HttpStatus.NOT_FOUND };
    }
    if (!fileService.fileExistsOnDisk(file)) {
      return { error: `${label}文件已丢失，请重新上传`, code: HttpStatus.NOT_FOUND };
    }

    const maxBytes = mediaType === 'video' ? asrConfig.maxVideoBytes : asrConfig.maxAudioBytes;
    if (file.size > maxBytes) {
      const maxMb = Math.round(maxBytes / (1024 * 1024));
      return { error: `${label}大小不能超过 ${maxMb}MB`, code: HttpStatus.BAD_REQUEST };
    }

    const supported =
      mediaType === 'video'
        ? isSupportedVideoMime(file.mimeType, file.originalName)
        : isSupportedAudioMime(file.mimeType);
    if (!supported) {
      return { error: `不支持的${label}类型：${file.mimeType || '未知'}`, code: HttpStatus.BAD_REQUEST };
    }

    return { file };
  }

  /** 查询任务（带归属校验） */
  async getTask(taskId: string, userId: string): Promise<ServiceResult<Subtitle.TaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await subtitleTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的字幕任务', code: HttpStatus.FORBIDDEN };
    }
    return { data: this.toRecord(task) };
  }

  /**
   * 取消一条排队中的任务。
   *
   * 仅 status=pending 可取消：取消走仓储的原子条件更新（与 claimNextPending 互斥），
   * 已被领取执行、已完成/失败的任务一律拒绝。
   */
  async cancel(taskId: string, userId: string): Promise<ServiceResult<Subtitle.TaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await subtitleTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能取消当前用户自己的字幕任务', code: HttpStatus.FORBIDDEN };
    }
    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    const cancelled = await subtitleTaskRepository.cancelPending(taskId);
    if (!cancelled) {
      // 读取与取消之间被 dispatcher 领取（条件更新与 claimNextPending 互斥）
      return { error: '任务已被调度器领取，无法取消', code: HttpStatus.CONFLICT };
    }
    // 视频任务的临时音频不会被 dispatcher 消费了，就地清掉，避免「排队中取消」把文件永久留在磁盘上
    if (cancelled.extractedAudioPath) {
      removeExtractedAudio(fileConfig.uploadDir, cancelled.extractedAudioPath, msg =>
        logger.warn(`[Subtitle] 取消任务时清理临时音频失败（${cancelled.extractedAudioPath}）：${msg}`),
      );
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
  ): Promise<ServiceResult<Subtitle.TaskQueuePosition>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await subtitleTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的字幕任务', code: HttpStatus.FORBIDDEN };
    }

    const [queueDepth, running] = await Promise.all([
      subtitleTaskRepository.countPending(),
      subtitleTaskRepository.countRunning(),
    ]);

    let position: number | null = null;
    let waitingAhead = 0;
    if (task.status === 'pending') {
      const before = await subtitleTaskRepository.countPendingBefore(task.createdAt);
      position = before + 1;
      waitingAhead = before + running;
    }

    return { data: { taskId, status: task.status, position, waitingAhead, queueDepth, running } };
  }

  /**
   * 字幕任务队列计数。
   *
   * 与 getQueuePosition 的区别：不针对具体任务、也不要求归属，返回的是全局计数。
   * pending/running 直接来自 Mongo（只统计 flag=1），跨 worker 全局一致；total = pending + running，
   * 即当前仍在排队或正在执行的任务数。
   */
  async getQueueStatus(): Promise<ServiceResult<Subtitle.QueueStatus>> {
    const [pending, running] = await Promise.all([
      subtitleTaskRepository.countPending(),
      subtitleTaskRepository.countRunning(),
    ]);
    return { data: { total: pending + running, pending, running } };
  }

  /** 分页查询当前用户的任务 */
  async listTasks(
    userId: string,
    query: Subtitle.TaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<Subtitle.TaskRecord>>> {
    const page = await subtitleTaskRepository.findPageByUser({
      userId,
      ...(query.status ? { status: query.status } : {}),
      page: query.page,
      limit: query.limit,
    });
    return {
      data: {
        list: page.list.map(doc => this.toRecord(doc)),
        total: page.total,
        page: page.page,
        limit: page.limit,
      },
    };
  }

  /** 引擎状态（进程内视角）。转写在本进程内无模型（本地 Whisper 是独立服务），故只报通道配置、队列与本地通道可达性。 */
  async getEngineStatus(): Promise<ServiceResult<Subtitle.EngineStatus>> {
    const queueDepth = await subtitleTaskRepository.countPending().catch(() => 0);
    const reachable = whisperConfig.enabled ? await getWhisperClient().ready() : false;
    const last = getWhisperClient().getLastProgress();

    return {
      data: {
        workerId: getWorkerId(),
        enabled: asrConfig.enabled,
        leader: subtitleDispatcher.isLeader(),
        provider: asrConfig.provider,
        queueDepth,
        concurrency: subtitleDispatcher.getConcurrency(),
        activeCount: subtitleDispatcher.getActiveCount(),
        whisper: { enabled: whisperConfig.enabled, baseUrl: whisperConfig.baseUrl, reachable },
        lastProgress: last,
      },
    };
  }

  /** 落库文档 → 对外记录（_id 映射为 id，并附带阶段中文描述） */
  private toRecord(doc: SubtitleTaskDocument): Subtitle.TaskRecord {
    return {
      id: String(doc._id),
      status: doc.status,
      sourceType: doc.sourceType,
      sourceMediaType: doc.sourceMediaType ?? 'audio',
      audioFileId: doc.audioFileId,
      audioUrl: doc.audioUrl,
      originalName: doc.originalName,
      language: doc.language,
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: subtitleStageLabel(doc.stage),
      message: doc.message,
      provider: doc.provider ?? '',
      srtFileId: doc.srtFileId ?? '',
      srtUrl: doc.srtUrl ?? '',
      cueCount: doc.cueCount ?? 0,
      audioDuration: doc.audioDuration ?? 0,
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

export const subtitleTaskService = new SubtitleTaskService();
