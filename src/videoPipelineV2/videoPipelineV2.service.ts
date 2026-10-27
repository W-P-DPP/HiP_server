import fs from 'node:fs';
import path from 'node:path';
import { isValidObjectId } from 'mongoose';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { DEFAULT_SPEED_MODE, SYNTHESIS_SPEED_MODES } from '../../utils/constant/indextts.ts';
import { videoPipelineV2StageLabel } from '../../utils/constant/videoPipelineV2.ts';
import indexttsConfig from '../../utils/indextts/indextts.config.ts';
import asrConfig from '../../utils/asr/asr.config.ts';
import whisperConfig from '../../utils/whisper/whisper.config.ts';
import { getWhisperClient } from '../../utils/whisper/WhisperHttpClient.ts';
import videoPipelineV2Config from '../../utils/videoPipelineV2/videoPipelineV2.config.ts';
import { voiceTrainV2VoiceService } from '../voiceTrainV2/voiceTrainV2Voice.service.ts';
import { parseSrt } from '../../utils/videoHelper/srt.ts';
import { probeDurationSec } from '../../utils/videoHelper/probe.ts';
import { fileService } from '../file/file.service.ts';
import { videoPipelineV2TaskRepository } from './videoPipelineV2Task.repository.ts';
import { videoPipelineV2Dispatcher } from './videoPipelineV2Dispatcher.ts';
import type { VideoPipelineV2TaskDocument } from './videoPipelineV2Task.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { VideoPipelineV2 } from '../../type/index.d.ts';

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/**
 * 视频生成管道 V2 服务。
 *
 * 提交只负责「校验 + 建任务 + 唤醒调度器」，不在请求链路里执行管道 —— 一次管道包含
 * IndexTTS 配音（数分钟）、Whisper 转写与 ffmpeg 合成，由 videoPipelineV2Dispatcher 异步
 * 领取执行，客户端轮询 GET /tasks/:taskId 取进度。
 *
 * 配音与字幕分别复用 voiceTrainV2 / subtitle 的子任务链路，本服务不直接触达 GPU 引擎。
 */
class VideoPipelineV2Service {
  /**
   * 提交管道任务。
   *
   * 提交时即校验音色归属与参考音可用性、文案长度、速度档位：让用户立刻拿到 403/404/409/400，
   * 而不是等任务跑起来才通过轮询发现。
   */
  async submit(dto: VideoPipelineV2.SubmitTaskDto): Promise<ServiceResult<VideoPipelineV2.TaskAccepted>> {
    if (!videoPipelineV2Config.enabled) {
      return { error: '视频生成管道 V2 未启用，暂不支持', code: HttpStatus.SERVICE_UNAVAILABLE };
    }
    if (!indexttsConfig.enabled) {
      return { error: 'IndexTTS 引擎未启用，暂不支持在线配音', code: HttpStatus.SERVICE_UNAVAILABLE };
    }
    if (!asrConfig.enabled) {
      return { error: '字幕生成未启用，无法生成视频字幕', code: HttpStatus.SERVICE_UNAVAILABLE };
    }
    if (!dto.voiceId || !isValidObjectId(dto.voiceId)) {
      return { error: '非法的 voiceId 参数', code: HttpStatus.BAD_REQUEST };
    }

    const text = (dto.text ?? '').trim();
    if (!text) {
      return { error: '文案不能为空', code: HttpStatus.BAD_REQUEST };
    }
    // 配音由 IndexTTS 完成，长度上限与音色合成保持一致（两侧必须同口径）
    if (text.length > indexttsConfig.maxTextChars) {
      return {
        error: `文案长度不能超过 ${indexttsConfig.maxTextChars} 字（当前 ${text.length} 字）`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    const speedMode = (dto.speedMode ?? DEFAULT_SPEED_MODE) as string;
    if (!(SYNTHESIS_SPEED_MODES as readonly string[]).includes(speedMode)) {
      return {
        error: `不支持的速度档位「${speedMode}」，可选：${SYNTHESIS_SPEED_MODES.join(' / ')}`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    const userId = dto.userId ?? '';
    // 音色可用性（归属 + 参考音存在）。配音阶段才解析会太晚。
    const voice = await voiceTrainV2VoiceService.resolveReference(dto.voiceId, userId);
    if ('error' in voice) {
      return { error: voice.error, code: voice.code };
    }

    const task = await videoPipelineV2TaskRepository.create({
      voiceId: dto.voiceId,
      text,
      speedMode,
      ...(dto.color ? { color: dto.color } : {}),
      ...(dto.keywords?.length ? { keywords: dto.keywords } : {}),
      ...(userId ? { userId } : {}),
    });

    // 懒启动调度器：没有这个调用，任务会一直躺在 pending 里
    videoPipelineV2Dispatcher.start();

    return { data: { taskId: String(task._id), status: task.status } };
  }

  /**
   * 提交「纯合成」任务（mode=compose）。
   *
   * 与 submit() 的区别：音频与字幕均已由外部产出（音频文件 id + SRT 文件 id），
   * 因此不校验 IndexTTS/ASR 通道、也不提交任何子任务，直接把两份产物落进任务，
   * 由调度器跳过配音/字幕阶段，只跑「背景轨 → ffmpeg 合成 → 落库」。
   *
   * 提交即校验两份文件的存在性、磁盘可用性与字幕可解析性，让用户立刻拿到 400/404，
   * 而不是等任务跑起来才通过轮询发现。voiceId/text/speedMode 仅随任务记录。
   */
  async submitCompose(
    dto: VideoPipelineV2.SubmitComposeTaskDto,
  ): Promise<ServiceResult<VideoPipelineV2.TaskAccepted>> {
    if (!videoPipelineV2Config.enabled) {
      return { error: '视频生成管道 V2 未启用，暂不支持', code: HttpStatus.SERVICE_UNAVAILABLE };
    }

    const audioFileId = (dto.audioFileId ?? '').trim();
    if (!audioFileId || !isValidObjectId(audioFileId)) {
      return { error: '非法的音频文件 id', code: HttpStatus.BAD_REQUEST };
    }
    const srtFileId = (dto.srtFileId ?? '').trim();
    if (!srtFileId || !isValidObjectId(srtFileId)) {
      return { error: '非法的字幕文件 id', code: HttpStatus.BAD_REQUEST };
    }

    const audioFile = await fileService.getById(audioFileId);
    if (!audioFile) {
      return { error: '音频文件不存在', code: HttpStatus.NOT_FOUND };
    }
    if (!fileService.fileExistsOnDisk(audioFile)) {
      return { error: '音频文件已丢失，请重新上传', code: HttpStatus.NOT_FOUND };
    }

    const srtFile = await fileService.getById(srtFileId);
    if (!srtFile) {
      return { error: '字幕文件不存在', code: HttpStatus.NOT_FOUND };
    }
    if (!fileService.fileExistsOnDisk(srtFile)) {
      return { error: '字幕文件已丢失，请重新上传', code: HttpStatus.NOT_FOUND };
    }

    // 解析字幕：既校验可解析，也顺带拿到 cue 数（背景轨按 cue 下标对应 keywords）
    const srtAbs = path.resolve(fileService.getAbsolutePath(srtFile));
    const cues = parseSrt(fs.readFileSync(srtAbs, 'utf8'));
    if (cues.length === 0) {
      return { error: '字幕文件无有效字幕段落', code: HttpStatus.BAD_REQUEST };
    }

    // 音频时长只用于背景轨末段补齐与展示，探测失败按 0 处理，不阻断提交
    const audioAbs = path.resolve(fileService.getAbsolutePath(audioFile));
    const audioDuration = await probeDurationSec(audioAbs).catch(() => 0);

    const speedMode = (dto.speedMode ?? DEFAULT_SPEED_MODE) as string;
    const userId = dto.userId ?? '';

    const task = await videoPipelineV2TaskRepository.createCompose({
      audioFileId,
      audioUrl: `/api/files/${audioFileId}/download`,
      audioDuration,
      srtFileId,
      srtUrl: `/api/files/${srtFileId}/download`,
      cueCount: cues.length,
      provider: 'compose',
      speedMode,
      ...(dto.color ? { color: dto.color } : {}),
      ...(dto.keywords?.length ? { keywords: dto.keywords } : {}),
      ...(dto.voiceId ? { voiceId: dto.voiceId } : {}),
      ...(dto.text ? { text: dto.text } : {}),
      ...(userId ? { userId } : {}),
    });

    // 懒启动调度器：没有这个调用，任务会一直躺在 pending 里
    videoPipelineV2Dispatcher.start();

    return { data: { taskId: String(task._id), status: task.status } };
  }

  /** 查询任务（带归属校验） */
  async getTask(taskId: string, userId: string): Promise<ServiceResult<VideoPipelineV2.TaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await videoPipelineV2TaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的管道任务', code: HttpStatus.FORBIDDEN };
    }
    return { data: this.toRecord(task) };
  }

  /**
   * 取消一条排队中的任务。
   *
   * 仅 status=pending 可取消：取消走仓储的原子条件更新（与 claimNextPending 互斥），
   * 已被领取执行、已完成/失败的任务一律拒绝。
   */
  async cancel(taskId: string, userId: string): Promise<ServiceResult<VideoPipelineV2.TaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await videoPipelineV2TaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能取消当前用户自己的管道任务', code: HttpStatus.FORBIDDEN };
    }
    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    const cancelled = await videoPipelineV2TaskRepository.cancelPending(taskId);
    if (!cancelled) {
      // 读取与取消之间被 dispatcher 领取（条件更新与 claimNextPending 互斥）
      return { error: '任务已被调度器领取，无法取消', code: HttpStatus.CONFLICT };
    }
    return { data: this.toRecord(cancelled) };
  }

  /**
   * 查询任务排队位置。口径与 claimNextPending 的领取顺序（createdAt 升序 FIFO）一致：
   * position = 队列中比我更早的 pending 数 + 1；waitingAhead 再额外算上正在执行的那条。
   * 注意 count 与领取不是原子的：返回值是查询瞬间的快照，位置会随调度推进而变小。
   */
  async getQueuePosition(
    taskId: string,
    userId: string,
  ): Promise<ServiceResult<VideoPipelineV2.TaskQueuePosition>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await videoPipelineV2TaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的管道任务', code: HttpStatus.FORBIDDEN };
    }

    const [queueDepth, running] = await Promise.all([
      videoPipelineV2TaskRepository.countPending(),
      videoPipelineV2TaskRepository.countRunning(),
    ]);

    let position: number | null = null;
    let waitingAhead = 0;
    if (task.status === 'pending') {
      const before = await videoPipelineV2TaskRepository.countPendingBefore(task.createdAt);
      position = before + 1;
      waitingAhead = before + running;
    }

    return { data: { taskId, status: task.status, position, waitingAhead, queueDepth, running } };
  }

  /**
   * 视频合成任务队列计数。
   *
   * 与 getQueuePosition 的区别：不针对具体任务、也不要求归属，返回的是全局计数。
   * pending/running 直接来自 Mongo（只统计 flag=1），跨 worker 全局一致；total = pending + running，
   * 即当前仍在排队或正在执行的任务数（与 V1 的 queue/status 同口径）。
   */
  async getQueueStatus(): Promise<ServiceResult<VideoPipelineV2.QueueStatus>> {
    const [pending, running] = await Promise.all([
      videoPipelineV2TaskRepository.countPending(),
      videoPipelineV2TaskRepository.countRunning(),
    ]);
    return { data: { total: pending + running, pending, running } };
  }

  /** 分页查询当前用户的任务 */
  async listTasks(
    userId: string,
    query: VideoPipelineV2.TaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<VideoPipelineV2.TaskRecord>>> {
    const page = await videoPipelineV2TaskRepository.findPageByUser({
      userId,
      ...(query.mode ? { mode: query.mode } : {}),
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

  /**
   * 引擎状态（进程内视角）。
   *
   * 管道不持有模型，配音/字幕各有自己的 leader dispatcher；这里只报告两段通道的开关与
   * 本地 Whisper 可达性，用于确认接线是否生效。GPU 指标请调用 GET /api/system/resources。
   */
  async getEngineStatus(): Promise<ServiceResult<VideoPipelineV2.EngineStatus>> {
    const queueDepth = await videoPipelineV2TaskRepository.countPending().catch(() => 0);
    const reachable = whisperConfig.enabled ? await getWhisperClient().ready() : false;

    return {
      data: {
        workerId: getWorkerId(),
        enabled: videoPipelineV2Config.enabled,
        leader: videoPipelineV2Dispatcher.isLeader(),
        voice: { enabled: indexttsConfig.enabled, mode: indexttsConfig.mode },
        subtitle: {
          enabled: asrConfig.enabled,
          provider: asrConfig.provider,
          whisper: { enabled: whisperConfig.enabled, reachable },
        },
        queueDepth,
        concurrency: videoPipelineV2Dispatcher.getConcurrency(),
        activeCount: videoPipelineV2Dispatcher.getActiveCount(),
      },
    };
  }

  /** 落库文档 → 对外记录（_id 映射为 id，并附带阶段中文描述） */
  private toRecord(doc: VideoPipelineV2TaskDocument): VideoPipelineV2.TaskRecord {
    return {
      id: String(doc._id),
      status: doc.status,
      // 历史数据无 mode 字段，按完整管道口径兜底
      mode: doc.mode ?? 'pipeline',
      text: doc.text,
      voiceId: doc.voiceId,
      speedMode: doc.speedMode,
      ...(doc.color ? { color: doc.color } : {}),
      keywords: doc.keywords ?? [],
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: videoPipelineV2StageLabel(doc.stage),
      message: doc.message,
      voiceTaskId: doc.voiceTaskId ?? '',
      audioFileId: doc.audioFileId ?? '',
      audioUrl: doc.audioUrl ?? '',
      audioDuration: doc.audioDuration ?? 0,
      subtitleTaskId: doc.subtitleTaskId ?? '',
      srtFileId: doc.srtFileId ?? '',
      srtUrl: doc.srtUrl ?? '',
      cueCount: doc.cueCount ?? 0,
      provider: doc.provider ?? '',
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

export const videoPipelineV2Service = new VideoPipelineV2Service();
