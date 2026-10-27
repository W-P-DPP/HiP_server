import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../../utils/Logger.ts';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { registerShutdownHook } from '../../utils/shutdownHooks.ts';
import { SHUTDOWN_TIMEOUT_MS, TASK_MAX_ATTEMPTS } from '../../utils/constant/ClusterConstants.ts';
import { indexttsStageLabel } from '../../utils/constant/indextts.ts';
import { subtitleStageLabel } from '../../utils/constant/subtitle.ts';
import { MaterialConstants } from '../../utils/constant/MaterialConstants.ts';
import { videoPipelineV2StageLabel } from '../../utils/constant/videoPipelineV2.ts';
import { parseSrt } from '../../utils/videoHelper/srt.ts';
import { buildBackgroundTrack } from '../../utils/videoHelper/background.ts';
import { toVideo } from '../../utils/videoHelper/toVideo.ts';
import { probeDurationMs, probeDurationSec } from '../../utils/videoHelper/probe.ts';
import { runIsolatedContext } from '../../utils/requestContext.ts';
import { tryAcquireLeaderLease, type LeaderLease } from '../../utils/leaderLease.ts';
import indexttsConfig from '../../utils/indextts/indextts.config.ts';
import { getIndexttsEngine } from '../../utils/indextts/indexttsEngineFactory.ts';
import videoPipelineV2Config from '../../utils/videoPipelineV2/videoPipelineV2.config.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import { voiceTrainV2VoiceService } from '../voiceTrainV2/voiceTrainV2Voice.service.ts';
import { voiceTrainV2SynthesisService } from '../voiceTrainV2/voiceTrainV2Synthesis.service.ts';
import { voiceTrainV2SynthesisTaskRepository } from '../voiceTrainV2/voiceTrainV2SynthesisTask.repository.ts';
import { subtitleTaskService } from '../subtitle/subtitleTask.service.ts';
import { subtitleTaskRepository } from '../subtitle/subtitleTask.repository.ts';
import { videoPipelineV2TaskRepository } from './videoPipelineV2Task.repository.ts';
import type { VideoPipelineV2TaskDocument, VideoPipelineV2TaskMode } from './videoPipelineV2Task.entity.ts';

const logger = Logger.getInstance();

/** 连续续期失败几次才判定失去 leader 地位（容忍一次 Redis 抖动） */
const MAX_RENEW_FAILURES = 2;

/**
 * 进度分带（总和到 0.98，落库 markSuccess 固定置满）。
 *
 * 阶段顺序：配音 → 字幕 → 背景（可选）→ 合成视频。配音与字幕复用各自的 leader 调度器，
 * 这里只把子任务的进度映射到本任务的区间；纯合成（mode=compose）跳过前两段，直接进入合成。
 */
const PROGRESS_RESOLVE = 0.02;
/** 纯合成模式（mode=compose）起始进度：跳过配音/字幕，直接从合成分带起步 */
const COMPOSE_BAND_START = 0.05;
const VOICE_BAND_START = 0.05;
const VOICE_BAND_SPAN = 0.3;
const SUBTITLE_BAND_START = 0.35;
const SUBTITLE_BAND_SPAN = 0.3;
const BACKGROUND_BAND_START = 0.65;
const RENDER_BAND_START = 0.8;
const PROGRESS_PERSIST = 0.98;

/**
 * 视频生成管道 V2 调度器。
 *
 * 与 subtitleDispatcher / digitalHumanDispatcher 同构：本服务跑在 node:cluster 下
 * （生产 CLUSTER_WORKERS=10），用 Redis 租约把调度循环收敛到唯一进程。
 *
 * 本调度器**不直接调用 GPU 引擎**：配音走 voiceTrainV2 合成任务、字幕走 subtitle 任务，
 * 两个子任务各自有全机唯一的 leader 调度器。若在这里直调 getIndexttsEngine()，
 * 就会与 indexttsDispatcher 争抢唯一那块 GPU，因此只做「提交 + 轮询 + 收口」。
 *
 * 队列就是 Mongo 里 status=pending 的任务集合，用在途计数把并发收敛到
 * videoPipelineV2Config.scheduler.concurrency。
 */
class VideoPipelineV2Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private lease: LeaderLease | null = null;
  private renewFailures = 0;
  private lastRenewAt = 0;
  /** 调度器并发上限（在途任务数），来自 VIDEO_PIPELINE_V2_CONCURRENCY */
  private readonly maxConcurrent = videoPipelineV2Config.scheduler.concurrency;
  /** 当前在途任务数（由 claimAndRun 维护，恒 ≤ maxConcurrent） */
  private active = 0;
  private running = false;
  /** 上次卡死任务清理时间（leader 专属，按 taskStaleMs/2 节流） */
  private lastRecoveryAt = 0;

  /** 懒启动（幂等）。首次提交任务时调用 */
  start(): void {
    if (this.running) return;
    if (!videoPipelineV2Config.enabled) return;
    this.running = true;
    logger.info(`[VideoPipelineV2] dispatcher 启动（worker=${getWorkerId()}）`);
    // 调度循环由 HTTP 请求触发，若不隔离，setTimeout 链会继承发起请求的 ALS 上下文，
    // 之后所有写库的 updateBy、新文档的 createBy 都会被填成那个用户的 id。
    runIsolatedContext(() => {
      void this.tick();
    });
  }

  isLeader(): boolean {
    return this.lease !== null;
  }

  /** 当前在途任务数 */
  getActiveCount(): number {
    return this.active;
  }

  /** 并发上限（经配置规整后的实际值） */
  getConcurrency(): number {
    return this.maxConcurrent;
  }

  /** 优雅关闭：停掉循环 → 等在途任务结算 → 释放租约 */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.active > 0) {
      // 一条管道含配音 + 转写 + 合成，SHUTDOWN_TIMEOUT_MS 装不下，等不到就放弃 ——
      // 由下一代的恢复流程把它重新入队（子任务 id 已落库，续跑会复用）。
      const deadline = Date.now() + Math.max(0, SHUTDOWN_TIMEOUT_MS - 1000);
      logger.info('[VideoPipelineV2] 等待在途任务结算…');
      while (this.active > 0 && Date.now() < deadline) {
        await sleep(200);
      }
    }

    if (this.lease) {
      await this.lease.release();
      this.lease = null;
    }
    logger.info('[VideoPipelineV2] dispatcher 已停止');
  }

  /** 调度循环：选举/续期 → 领取 pending 任务 → 执行 */
  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.electAndRenew();
      if (this.lease) await this.recoverStuckTasks();
      // 就绪闸门：IndexTTS 推理服务不可达（典型是容器重启）时不领取需要配音的 pipeline 任务，
      // 让它们留在 pending，等容器恢复后自动继续 —— 好过领出来干等到超时。这是只读探活，
      // 不触达引擎执行路径。纯合成（compose）不依赖 IndexTTS，引擎不可达时仍照常领取。
      // 本地模式下 canAcceptWork 恒为 true，不会挡住懒加载。
      const engine = getIndexttsEngine(indexttsConfig);
      if (this.lease) {
        if (await engine.canAcceptWork()) {
          await this.claimAndRun();
        } else {
          await this.claimAndRun('compose');
        }
      }
    } catch (err) {
      logger.error(`[VideoPipelineV2] 调度循环异常：${err instanceof Error ? err.message : err}`);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), videoPipelineV2Config.scheduler.pollIntervalMs);
    this.timer.unref();
  }

  /** 在并发额度内领取并启动任务，直到配额用尽或队列为空（单线程内同步推进，无竞态） */
  private async claimAndRun(mode?: VideoPipelineV2TaskMode): Promise<void> {
    while (this.running && this.active < this.maxConcurrent) {
      const task = await videoPipelineV2TaskRepository.claimNextPending(getWorkerId(), mode);
      if (!task) return;
      this.active += 1;
      // execute 自身不抛（异常都落到 markFailed），但 finally 派生出的 promise
      // 仍需兜底 catch —— 否则任何逸出异常都会变成 unhandledRejection 杀掉 worker
      void this.execute(task)
        .catch(err => logger.error(`[VideoPipelineV2] 任务执行异常：${err instanceof Error ? err.message : err}`))
        .finally(() => {
          this.active -= 1;
        });
    }
  }

  /** 首次由调用方按 pollIntervalMs 驱动，故续期也放在这里 */
  private async electAndRenew(): Promise<void> {
    const { leaseTtlMs } = videoPipelineV2Config.scheduler;

    if (!this.lease) {
      this.lease = await tryAcquireLeaderLease({
        key: videoPipelineV2Config.scheduler.leaderKey,
        ttlMs: leaseTtlMs,
      });
      if (this.lease) {
        this.renewFailures = 0;
        this.lastRenewAt = Date.now();
        logger.info(`[VideoPipelineV2] 获得 leader 租约（worker=${getWorkerId()}）`);
      }
      return;
    }

    if (Date.now() - this.lastRenewAt < leaseTtlMs / 2) return;
    this.lastRenewAt = Date.now();

    const ok = await this.lease.renew();
    if (ok) {
      this.renewFailures = 0;
      return;
    }

    this.renewFailures += 1;
    if (this.renewFailures < MAX_RENEW_FAILURES) {
      logger.warn(`[VideoPipelineV2] 租约续期失败（第 ${this.renewFailures} 次），下次重试`);
      return;
    }

    logger.error('[VideoPipelineV2] 连续续期失败，让出 leader');
    await this.lease.release();
    this.lease = null;
    this.renewFailures = 0;
  }

  /**
   * 卡死任务恢复（仅 leader 调用）。
   *
   * ① 接手租约时立刻清扫**任何 workerId** 的 running 孤儿（此刻本进程没有在途任务，
   *    Mongo 里的 running 行必然是上一代进程遗留）。
   * ② 周期性按 updatedAt 阈值处理跨进程孤儿（阈值须大于一次完整管道耗时）。
   *
   * 以「重新入队」为主：中断多发生在进程重启/发布期间，此时配音/字幕子任务可能已完成或
   * 仍在跑，直接判失败会白费一次 GPU 合成/转写。只有 attempts 达到 TASK_MAX_ATTEMPTS 才失败。
   */
  private async recoverStuckTasks(): Promise<void> {
    if (this.active > 0) return; // 本进程有在途任务，不做任何"恢复"，避免误伤自己
    const interval = Math.max(60_000, Math.floor(videoPipelineV2Config.scheduler.taskStaleMs / 2));
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();

    const requeued = await videoPipelineV2TaskRepository.requeueOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeued > 0) {
      logger.warn(`[VideoPipelineV2] 恢复：${requeued} 条中断任务已重新入队（含其他 worker 遗留）`);
    }
    const exhausted = await videoPipelineV2TaskRepository.failExhaustedOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhausted > 0) {
      logger.warn(`[VideoPipelineV2] 恢复：${exhausted} 条达重试上限的任务已标记失败`);
    }

    const staleBefore = new Date(Date.now() - videoPipelineV2Config.scheduler.taskStaleMs);
    const requeuedStale = await videoPipelineV2TaskRepository.requeueStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeuedStale > 0) {
      logger.warn(`[VideoPipelineV2] 恢复：${requeuedStale} 条超时未更新的任务已重新入队`);
    }
    const exhaustedStale = await videoPipelineV2TaskRepository.failExhaustedStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhaustedStale > 0) {
      logger.warn(`[VideoPipelineV2] 恢复：${exhaustedStale} 条超时且达重试上限的任务已标记失败`);
    }
  }

  /** 执行一条已领取的任务；任何异常都落到 markFailed，不向上抛 */
  private async execute(task: VideoPipelineV2TaskDocument): Promise<void> {
    const taskId = String(task._id);
    // 背景素材临时工作目录（dot 前缀，Express static 默认忽略 dotfiles 不暴露）
    const workDir = path.join(fileConfig.uploadDir, '.pipeline', crypto.randomUUID());

    try {
      // 音频/字幕产物：pipeline 模式由配音 + 字幕子任务产出，compose 模式复用提交时已落库的产物
      let audio: { fileId: string; url: string; duration: number };
      let sub: { srtFileId: string; srtUrl: string; cueCount: number; provider: string };

      if (task.mode === 'compose') {
        // ---- 纯合成：音频/字幕均已存在，跳过 IndexTTS 配音与 Whisper 字幕 ----
        await this.reportProgress(taskId, COMPOSE_BAND_START, 'compose', videoPipelineV2StageLabel('compose'));
        if (!task.audioFileId || !task.srtFileId) {
          throw new Error('纯合成任务缺少音频或字幕产物，请重新提交');
        }
        audio = { fileId: task.audioFileId, url: task.audioUrl, duration: task.audioDuration };
        sub = {
          srtFileId: task.srtFileId,
          srtUrl: task.srtUrl,
          cueCount: task.cueCount,
          provider: task.provider,
        };
      } else {
        // ---- ① 解析音色参考音（快速失败，先于任何 GPU 消耗） ----
        await this.reportProgress(taskId, PROGRESS_RESOLVE, 'resolve', videoPipelineV2StageLabel('resolve'));
        const voice = await voiceTrainV2VoiceService.resolveReference(task.voiceId, task.userId);
        if ('error' in voice) throw new Error(voice.error);

        // ---- ② 配音：复用 IndexTTS 合成链路（不直接调引擎，避免与其调度器争单飞） ----
        const voiceTaskId = await this.ensureVoiceTask(task);
        audio = await this.waitForVoice(taskId, voiceTaskId);
        await videoPipelineV2TaskRepository.setAudio(taskId, {
          audioFileId: audio.fileId,
          audioUrl: audio.url,
          audioDuration: audio.duration,
        });

        // ---- ③ 字幕：复用 subtitle 任务链路（本地 Whisper 优先，随全局 ASR_PROVIDER） ----
        const subtitleTaskId = await this.ensureSubtitleTask(task, audio.fileId);
        sub = await this.waitForSubtitle(taskId, subtitleTaskId);
        await videoPipelineV2TaskRepository.setSubtitle(taskId, {
          srtFileId: sub.srtFileId,
          srtUrl: sub.srtUrl,
          cueCount: sub.cueCount,
          provider: sub.provider,
        });
      }

      // 解析音频/字幕绝对路径（本地 ffmpeg 需要真实文件路径）
      const audioFile = await fileService.getById(audio.fileId);
      if (!audioFile) throw new Error('配音产物已失效，请重新提交');
      const audioAbs = path.resolve(fileService.getAbsolutePath(audioFile));
      if (!fs.existsSync(audioAbs)) throw new Error('配音产物文件已丢失，请重新提交');

      const srtFile = await fileService.getById(sub.srtFileId);
      if (!srtFile) throw new Error('字幕产物已失效，请重新提交');
      const srtAbs = path.resolve(fileService.getAbsolutePath(srtFile));
      if (!fs.existsSync(srtAbs)) throw new Error('字幕文件已丢失，请重新提交');

      // ---- ④ 背景轨（可选）：按字幕段落构建 Pixabay 素材背景，失败回退纯色 ----
      let backgroundPath: string | undefined;
      const cues = parseSrt(fs.readFileSync(srtAbs, 'utf8'));
      if (cues.length > 0 && MaterialConstants.PIXABAY_API_KEY.trim()) {
        try {
          fs.mkdirSync(workDir, { recursive: true });
          await this.reportProgress(
            taskId,
            BACKGROUND_BAND_START,
            'background',
            videoPipelineV2StageLabel('background'),
          );
          const audioDurationMs = await probeDurationMs(audioAbs);
          const bg = await buildBackgroundTrack({
            cues,
            audioDurationMs,
            ...(task.keywords?.length ? { keywords: task.keywords } : {}),
            ...(task.color ? { color: task.color } : {}),
            workDir,
            ...(task.userId ? { userId: task.userId } : {}),
          });
          backgroundPath = bg?.bgPath;
        } catch (err) {
          logger.warn(
            `[VideoPipelineV2] 背景素材构建失败，回退纯色背景：${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // ---- ⑤ 合成视频：复用 toVideo（音频 + SRT 烧录 → mp4，内部注册 file 记录） ----
      await this.reportProgress(taskId, RENDER_BAND_START, 'render', videoPipelineV2StageLabel('render'));
      const uuid = crypto.randomUUID();
      const video = await toVideo(
        audioAbs,
        srtAbs,
        `videoPipelineV2-${uuid}.mp4`,
        task.color,
        backgroundPath,
      );

      // ---- ⑥ 落库：产物信息写回任务 ----
      await this.reportProgress(taskId, PROGRESS_PERSIST, 'persist', videoPipelineV2StageLabel('persist'));
      const videoDuration = await this.videoDurationOf(video.fileId);
      await videoPipelineV2TaskRepository.markSuccess(taskId, {
        audioFileId: audio.fileId,
        audioUrl: audio.url,
        audioDuration: audio.duration,
        srtFileId: sub.srtFileId,
        srtUrl: sub.srtUrl,
        cueCount: sub.cueCount,
        provider: sub.provider,
        videoFileId: video.fileId,
        videoUrl: video.url,
        videoDuration,
        finishedAt: new Date(),
      });
      logger.info(
        `[VideoPipelineV2] 合成完成 task=${taskId} provider=${sub.provider} 字幕=${sub.cueCount} 条 file=${video.fileId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[VideoPipelineV2] 合成失败 task=${taskId}：${message}`);
      await videoPipelineV2TaskRepository
        .markFailed(taskId, message, new Date())
        .catch(markErr => logger.error(`[VideoPipelineV2] 标记失败态也失败了 task=${taskId}：${markErr}`));
    } finally {
      // 背景素材 clip / 分段 / bg / list 全清（Pixabay large 5–30MB，长文本峰值可达 GB 级）
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响结果
      }
    }
  }

  /**
   * 确保有一个可用的配音任务：优先复用 task.voiceTaskId。
   *
   * 中断（重启/发布）后重跑时，若不复用就会再烧一次完整 GPU 合成；而远端作业本身以
   * clientJobId(= 合成任务 id) 幂等，续用同一个配音任务即可命中同一作业。
   * 只有配音任务不存在或已 failed 时才重新提交。
   */
  private async ensureVoiceTask(task: VideoPipelineV2TaskDocument): Promise<string> {
    const taskId = String(task._id);
    const existing = task.voiceTaskId;
    if (existing) {
      const doc = await voiceTrainV2SynthesisTaskRepository.findById(existing);
      // pending/running 续等、success 会在 waitForVoice 里立即返回，只有 failed 需要重投
      if (doc && doc.status !== 'failed') return existing;
    }

    const submitted = await voiceTrainV2SynthesisService.submit({
      voiceId: task.voiceId,
      text: task.text,
      speedMode: task.speedMode,
      purpose: 'synthesis',
      ...(task.userId ? { userId: task.userId } : {}),
    });
    if ('error' in submitted) throw new Error(`提交配音任务失败：${submitted.error}`);
    const voiceTaskId = submitted.data.taskId;
    await videoPipelineV2TaskRepository.setVoice(taskId, { voiceTaskId });
    logger.info(`[VideoPipelineV2] 配音已提交 task=${taskId} voiceTask=${voiceTaskId}`);
    return voiceTaskId;
  }

  /**
   * 轮询配音任务直到成功/失败，成功时返回音频产物。
   *
   * 配音走 indexTTS 自己的调度器，这里只做等待与进度映射（0.05–0.35）。
   * 超时取 videoPipelineV2Config.voiceTimeoutMs —— 必须 ≥ INDEXTTS_JOB_TIMEOUT_MS。
   */
  private async waitForVoice(
    taskId: string,
    voiceTaskId: string,
  ): Promise<{ fileId: string; url: string; duration: number }> {
    const deadline = Date.now() + videoPipelineV2Config.voiceTimeoutMs;
    let lastWriteAt = 0;

    while (Date.now() < deadline) {
      const doc = await voiceTrainV2SynthesisTaskRepository.findById(voiceTaskId);
      if (!doc) throw new Error('配音任务不存在（可能已被清理），请重新提交');

      if (doc.status === 'success') {
        if (!doc.resultFileId) throw new Error('配音任务已完成但未产出音频，请重新提交');
        return { fileId: doc.resultFileId, url: doc.resultUrl, duration: doc.duration };
      }
      if (doc.status === 'failed') {
        throw new Error(`配音失败：${doc.message || '未知原因'}`);
      }

      const now = Date.now();
      if (now - lastWriteAt >= videoPipelineV2Config.scheduler.progressMinIntervalMs) {
        lastWriteAt = now;
        const pct = VOICE_BAND_START + Math.max(0, Math.min(1, doc.progress)) * VOICE_BAND_SPAN;
        // 透传配音任务自身的 message（形如「IndexTTS 合成中 · 段落 12/40」），
        // 否则长文本合成期间前端会看到一句恒定不变的提示，像卡死。
        await this.reportProgress(
          taskId,
          pct,
          'voice_synth',
          `配音合成中 · ${doc.message || indexttsStageLabel(doc.stage)}`,
        );
      }
      await sleep(videoPipelineV2Config.scheduler.pollIntervalMs);
    }
    throw new Error('配音超时，请缩短文案后重试');
  }

  /**
   * 确保有一个可用的字幕任务（对配音音频跑 ASR）：优先复用 task.subtitleTaskId。
   *
   * 与 ensureVoiceTask 同思路 —— 中断重跑时复用它，避免对同一段音频重复消耗一次转写。
   * 只有子任务不存在或已 failed 才重新提交。
   */
  private async ensureSubtitleTask(
    task: VideoPipelineV2TaskDocument,
    audioFileId: string,
  ): Promise<string> {
    const taskId = String(task._id);
    const existing = task.subtitleTaskId;
    if (existing) {
      const doc = await subtitleTaskRepository.findById(existing);
      // pending/running 续等、success 会在 waitForSubtitle 里立即返回，只有 failed 需要重投
      if (doc && doc.status !== 'failed') return existing;
    }

    const submitted = await subtitleTaskService.submit({
      fileId: audioFileId,
      sourceType: 'fileId',
      ...(task.userId ? { userId: task.userId } : {}),
    });
    if ('error' in submitted) throw new Error(`提交字幕任务失败：${submitted.error}`);
    const subtitleTaskId = submitted.data.taskId;
    await videoPipelineV2TaskRepository.setSubtitle(taskId, { subtitleTaskId });
    logger.info(`[VideoPipelineV2] 字幕已提交 task=${taskId} subtitleTask=${subtitleTaskId}`);
    return subtitleTaskId;
  }

  /**
   * 轮询字幕任务直到成功/失败，成功时返回 SRT 产物。
   *
   * 转写走 subtitleDispatcher 的队列与并发约束，这里只做等待与进度映射（0.35–0.65）；
   * 超时取 videoPipelineV2Config.subtitleTimeoutMs —— 必须 ≥ SUBTITLE_TASK_STALE_MS。
   */
  private async waitForSubtitle(
    taskId: string,
    subtitleTaskId: string,
  ): Promise<{ srtFileId: string; srtUrl: string; cueCount: number; provider: string }> {
    const deadline = Date.now() + videoPipelineV2Config.subtitleTimeoutMs;
    let lastWriteAt = 0;

    while (Date.now() < deadline) {
      const doc = await subtitleTaskRepository.findById(subtitleTaskId);
      if (!doc) throw new Error('字幕任务不存在（可能已被清理），请重新提交');

      if (doc.status === 'success') {
        if (!doc.srtFileId) throw new Error('字幕任务已完成但未产出字幕，请重新提交');
        return {
          srtFileId: doc.srtFileId,
          srtUrl: doc.srtUrl,
          cueCount: doc.cueCount ?? 0,
          provider: doc.provider ?? '',
        };
      }
      if (doc.status === 'failed') {
        throw new Error(`字幕生成失败：${doc.message || '未知原因'}`);
      }

      const now = Date.now();
      if (now - lastWriteAt >= videoPipelineV2Config.scheduler.progressMinIntervalMs) {
        lastWriteAt = now;
        const pct = SUBTITLE_BAND_START + Math.max(0, Math.min(1, doc.progress)) * SUBTITLE_BAND_SPAN;
        // 与配音阶段同理：透传子任务 message，否则长音频转写期间提示恒定不变，像卡死
        await this.reportProgress(
          taskId,
          pct,
          'subtitle_asr',
          `生成字幕中 · ${doc.message || subtitleStageLabel(doc.stage)}`,
        );
      }
      await sleep(videoPipelineV2Config.scheduler.pollIntervalMs);
    }
    throw new Error('字幕生成超时，请缩短文案后重试');
  }

  /** 探测已注册成品的时长；失败按 0 处理（时长只是展示信息，不该让成功的产物变失败） */
  private async videoDurationOf(fileId: string): Promise<number> {
    try {
      const doc = await fileService.getById(fileId);
      if (!doc) return 0;
      return await probeDurationSec(path.resolve(fileService.getAbsolutePath(doc)));
    } catch {
      return 0;
    }
  }

  /** 写一次进度（关键节点不受节流限制） */
  private async reportProgress(
    taskId: string,
    progress: number,
    stage: string,
    message: string,
  ): Promise<void> {
    // 隔离 ALS：避免把某个请求用户的 id 写进 updateBy（见 start() 的说明）
    await runIsolatedContext(() =>
      videoPipelineV2TaskRepository.updateProgress(taskId, { progress, stage, message }).catch(() => {
        // 进度上报失败不影响合成本身
      }),
    );
  }
}

export const videoPipelineV2Dispatcher = new VideoPipelineV2Dispatcher();

// 关机钩子：与 IndexTTS/字幕/数字人/视频队列同样的排空语义
registerShutdownHook(() => videoPipelineV2Dispatcher.stop());
