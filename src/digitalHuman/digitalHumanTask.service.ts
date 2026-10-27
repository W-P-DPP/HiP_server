import { isValidObjectId } from 'mongoose';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import {
  DEFAULT_SPEED_MODE,
  SYNTHESIS_SPEED_MODES,
} from '../../utils/constant/indextts.ts';
import { digitalHumanStageLabel } from '../../utils/constant/digitalHuman.ts';
import indexttsConfig from '../../utils/indextts/indextts.config.ts';
import heygemConfig from '../../utils/heygem/heygem.config.ts';
import asrConfig from '../../utils/asr/asr.config.ts';
import { getHeygemClient } from '../../utils/heygem/HeygemClient.ts';
import { isMountWritable } from '../../utils/heygem/heygemMount.ts';
import { digitalHumanAvatarService } from './digitalHumanAvatar.service.ts';
import { digitalHumanTaskRepository } from './digitalHumanTask.repository.ts';
import { digitalHumanDispatcher } from './digitalHumanDispatcher.ts';
import { voiceTrainV2VoiceService } from '../voiceTrainV2/voiceTrainV2Voice.service.ts';
import { subtitleTaskRepository } from '../subtitle/subtitleTask.repository.ts';
import type { DigitalHumanTaskDocument } from './digitalHumanTask.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type { DigitalHuman } from '../../type/index.d.ts';

/** service 返回联合类型：成功 { data }，失败 { error, code }（code 直接透传给 controller） */
type ServiceResult<T> = { data: T } | { error: string; code: number };

/**
 * 数字人合成服务。
 *
 * 提交只负责「校验 + 建任务 + 唤醒调度器」，不在请求链路里执行合成 —— 一次合成包含配音
 * （数分钟）与对口型（数分钟），且在持有 duix 容器的那个 leader 进程内按
 * DIGITALHUMAN_CONCURRENCY 受限执行，所以由 digitalHumanDispatcher 异步领取执行，
 * 客户端轮询 GET /tasks/:taskId 取进度。
 */
class DigitalHumanTaskService {
  /**
   * 提交数字人任务。
   *
   * 提交时即校验形象/音色归属与可用性、文案长度：让用户立刻拿到 403/409/400，
   * 而不是等任务跑起来才失败（那时只能通过轮询发现）。
   */
  async submit(dto: DigitalHuman.SubmitTaskDto): Promise<ServiceResult<DigitalHuman.TaskAccepted>> {
    if (!heygemConfig.enabled) {
      return { error: '数字人引擎未启用，暂不支持合成', code: HttpStatus.SERVICE_UNAVAILABLE };
    }
    if (!dto.avatarId || !isValidObjectId(dto.avatarId)) {
      return { error: '非法的 avatarId 参数', code: HttpStatus.BAD_REQUEST };
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

    // 烧录依赖字幕生成链路（对配音音频跑 ASR）。这里就拒掉，避免任务跑完几分钟才在烧录阶段失败。
    const burnSubtitles = dto.burnSubtitles === true;
    if (burnSubtitles && !asrConfig.enabled) {
      return { error: '字幕生成未启用，无法烧录字幕', code: HttpStatus.SERVICE_UNAVAILABLE };
    }

    const userId = dto.userId ?? '';

    // 形象可用性（归属 + 参考视频存在）
    const avatar = await digitalHumanAvatarService.resolveReference(dto.avatarId, userId);
    if ('error' in avatar) {
      return { error: avatar.error, code: avatar.code };
    }
    // 音色可用性（归属 + 参考音存在）。配音阶段才解析会太晚。
    const voice = await voiceTrainV2VoiceService.resolveReference(dto.voiceId, userId);
    if ('error' in voice) {
      return { error: voice.error, code: voice.code };
    }

    const task = await digitalHumanTaskRepository.create({
      avatarId: dto.avatarId,
      voiceId: dto.voiceId,
      text,
      speedMode,
      burnSubtitles,
      ...(dto.subtitleOptions ? { subtitleOptions: dto.subtitleOptions } : {}),
      ...(userId ? { userId } : {}),
    });

    // 懒启动调度器：没有这个调用，任务会一直躺在 pending 里
    digitalHumanDispatcher.start();

    return { data: { taskId: String(task._id), status: task.status } };
  }

  /**
   * 提交「复用已有字幕任务」的数字人任务。
   *
   * 与 submit 的差异：字幕不再对本次配音跑 ASR，而是直接复用调用方指定的字幕任务
   * （其已生成的 SRT 会被烧录进成片）；配音仍由服务端用 voiceId + text 合成。
   * 提交时即校验形象/音色归属与字幕任务可用性，让调用方立刻拿到 400/403/404/409，
   * 而不是排到队、跑到一半才失败。
   */
  async submitWithSubtitle(
    dto: DigitalHuman.SubmitWithSubtitleTaskDto,
  ): Promise<ServiceResult<DigitalHuman.TaskAccepted>> {
    if (!heygemConfig.enabled) {
      return { error: '数字人引擎未启用，暂不支持合成', code: HttpStatus.SERVICE_UNAVAILABLE };
    }
    if (!dto.avatarId || !isValidObjectId(dto.avatarId)) {
      return { error: '非法的 avatarId 参数', code: HttpStatus.BAD_REQUEST };
    }
    if (!dto.voiceId || !isValidObjectId(dto.voiceId)) {
      return { error: '非法的 voiceId 参数', code: HttpStatus.BAD_REQUEST };
    }
    if (!dto.subtitleId || !isValidObjectId(dto.subtitleId)) {
      return { error: '非法的 subtitleId 参数', code: HttpStatus.BAD_REQUEST };
    }

    const text = (dto.text ?? '').trim();
    if (!text) {
      return { error: '文案不能为空', code: HttpStatus.BAD_REQUEST };
    }
    // 配音仍由 IndexTTS 完成，长度上限与音色合成保持一致（两侧必须同口径）
    if (text.length > indexttsConfig.maxTextChars) {
      return {
        error: `文案长度不能超过 ${indexttsConfig.maxTextChars} 字（当前 ${text.length} 字）`,
        code: HttpStatus.BAD_REQUEST,
      };
    }

    const userId = dto.userId ?? '';

    // 复用的字幕任务必须存在且处于可复用状态：failed/cancelled 无可用产物，
    // success 必须有 SRT；pending/running 交给调度器继续等待。
    const subtitleTask = await subtitleTaskRepository.findById(dto.subtitleId);
    if (!subtitleTask) {
      return { error: '字幕任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (subtitleTask.userId !== userId) {
      return { error: '只能复用当前用户自己的字幕任务', code: HttpStatus.FORBIDDEN };
    }
    if (subtitleTask.status === 'failed' || subtitleTask.status === 'cancelled') {
      return { error: `该字幕任务${subtitleTask.status === 'failed' ? '已失败' : '已取消'}，无法复用`, code: HttpStatus.CONFLICT };
    }
    if (subtitleTask.status === 'success' && !subtitleTask.srtFileId) {
      return { error: '该字幕任务已完成但未产出字幕，无法复用', code: HttpStatus.CONFLICT };
    }

    // 形象可用性（归属 + 参考视频存在）
    const avatar = await digitalHumanAvatarService.resolveReference(dto.avatarId, userId);
    if ('error' in avatar) {
      return { error: avatar.error, code: avatar.code };
    }
    // 音色可用性（归属 + 参考音存在）
    const voice = await voiceTrainV2VoiceService.resolveReference(dto.voiceId, userId);
    if ('error' in voice) {
      return { error: voice.error, code: voice.code };
    }

    const task = await digitalHumanTaskRepository.create({
      avatarId: dto.avatarId,
      voiceId: dto.voiceId,
      text,
      // 本接口不接受速度档位，取默认值
      speedMode: DEFAULT_SPEED_MODE,
      // 复用给定字幕任务即隐含烧录
      burnSubtitles: true,
      subtitleTaskId: dto.subtitleId,
      ...(dto.subtitleOptions ? { subtitleOptions: dto.subtitleOptions } : {}),
      ...(userId ? { userId } : {}),
    });

    // 懒启动调度器：没有这个调用，任务会一直躺在 pending 里
    digitalHumanDispatcher.start();

    return { data: { taskId: String(task._id), status: task.status } };
  }

  /** 查询任务（带归属校验） */
  async getTask(taskId: string, userId: string): Promise<ServiceResult<DigitalHuman.TaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await digitalHumanTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的合成任务', code: HttpStatus.FORBIDDEN };
    }
    return { data: this.toRecord(task) };
  }

  /**
   * 取消一条排队中的任务。
   *
   * 仅 status=pending 可取消：取消走仓储的原子条件更新（与 claimNextPending 互斥），
   * 已被领取执行、已完成/失败的任务一律拒绝。
   */
  async cancel(taskId: string, userId: string): Promise<ServiceResult<DigitalHuman.TaskRecord>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await digitalHumanTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能取消当前用户自己的合成任务', code: HttpStatus.FORBIDDEN };
    }
    if (task.status !== 'pending') {
      return { error: '任务已开始执行或已结束，无法取消', code: HttpStatus.CONFLICT };
    }

    const cancelled = await digitalHumanTaskRepository.cancelPending(taskId);
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
  ): Promise<ServiceResult<DigitalHuman.TaskQueuePosition>> {
    if (!isValidObjectId(taskId)) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    const task = await digitalHumanTaskRepository.findById(taskId);
    if (!task) {
      return { error: '任务不存在', code: HttpStatus.NOT_FOUND };
    }
    if (task.userId !== userId) {
      return { error: '只能查看当前用户自己的合成任务', code: HttpStatus.FORBIDDEN };
    }

    const [queueDepth, running] = await Promise.all([
      digitalHumanTaskRepository.countPending(),
      digitalHumanTaskRepository.countRunning(),
    ]);

    let position: number | null = null;
    let waitingAhead = 0;
    if (task.status === 'pending') {
      const before = await digitalHumanTaskRepository.countPendingBefore(task.createdAt);
      position = before + 1;
      waitingAhead = before + running;
    }

    return { data: { taskId, status: task.status, position, waitingAhead, queueDepth, running } };
  }

  /**
   * 数字人合成任务队列计数。
   *
   * 与 getQueuePosition 的区别：不针对具体任务、也不要求归属，返回的是全局计数。
   * pending/running 直接来自 Mongo（只统计 flag=1），跨 worker 全局一致；total = pending + running，
   * 即当前仍在排队或正在执行的任务数。
   */
  async getQueueStatus(): Promise<ServiceResult<DigitalHuman.QueueStatus>> {
    const [pending, running] = await Promise.all([
      digitalHumanTaskRepository.countPending(),
      digitalHumanTaskRepository.countRunning(),
    ]);
    return { data: { total: pending + running, pending, running } };
  }

  /** 分页查询当前用户的合成任务 */
  async listTasks(
    userId: string,
    query: DigitalHuman.TaskQuery,
  ): Promise<ServiceResult<PaginatedResponse<DigitalHuman.TaskRecord>>> {
    const page = await digitalHumanTaskRepository.findPageByUser({
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

  /**
   * 引擎状态（进程内视角）。
   *
   * 附带 mount 配置：挂载目录与 duix 容器不一致是头号故障源，暴露出来便于第一时间定位。
   * GPU 利用率/显存请调用已有的 GET /api/system/resources。
   */
  async getEngineStatus(): Promise<ServiceResult<DigitalHuman.EngineStatus>> {
    const client = getHeygemClient();
    const queueDepth = await digitalHumanTaskRepository.countPending().catch(() => 0);
    const info = await client.getEngineInfo().catch(() => null);
    const last = client.getLastProgress();

    return {
      data: {
        workerId: getWorkerId(),
        enabled: heygemConfig.enabled,
        leader: digitalHumanDispatcher.isLeader(),
        healthy: heygemConfig.enabled && !client.isUnhealthy(),
        baseUrl: heygemConfig.baseUrl,
        reachable: info?.reachable ?? false,
        mountDir: heygemConfig.mountDir,
        containerPrefix: heygemConfig.containerPrefix,
        mountWritable: isMountWritable(),
        queueDepth,
        concurrency: digitalHumanDispatcher.getConcurrency(),
        activeCount: digitalHumanDispatcher.getActiveCount(),
        lastProgress: last ? { pct: last.pct, message: last.message } : null,
        ...(info?.error ? { error: info.error } : {}),
      },
    };
  }

  /** 落库文档 → 对外记录（_id 映射为 id，并附带阶段中文描述） */
  private toRecord(doc: DigitalHumanTaskDocument): DigitalHuman.TaskRecord {
    return {
      id: String(doc._id),
      status: doc.status,
      avatarId: doc.avatarId,
      voiceId: doc.voiceId,
      text: doc.text,
      speedMode: doc.speedMode,
      progress: doc.progress,
      stage: doc.stage,
      stageLabel: digitalHumanStageLabel(doc.stage),
      message: doc.message,
      audioTaskId: doc.audioTaskId ?? '',
      audioFileId: doc.audioFileId ?? '',
      audioUrl: doc.audioUrl ?? '',
      audioDuration: doc.audioDuration ?? 0,
      resultUrl: doc.resultUrl ?? '',
      resultFileId: doc.resultFileId ?? '',
      videoDuration: doc.videoDuration ?? 0,
      burnSubtitles: doc.burnSubtitles === true,
      subtitleTaskId: doc.subtitleTaskId ?? '',
      srtFileId: doc.srtFileId ?? '',
      srtUrl: doc.srtUrl ?? '',
      cueCount: doc.cueCount ?? 0,
      rawVideoFileId: doc.rawVideoFileId ?? '',
      rawVideoUrl: doc.rawVideoUrl ?? '',
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

export const digitalHumanTaskService = new DigitalHumanTaskService();
