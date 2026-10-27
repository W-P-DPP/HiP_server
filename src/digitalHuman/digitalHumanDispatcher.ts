import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../../utils/Logger.ts';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { registerShutdownHook } from '../../utils/shutdownHooks.ts';
import { SHUTDOWN_TIMEOUT_MS, TASK_MAX_ATTEMPTS } from '../../utils/constant/ClusterConstants.ts';
import { indexttsStageLabel } from '../../utils/constant/indextts.ts';
import {
  DIGITAL_HUMAN_AUDIO_SAMPLE_RATE,
  DIGITAL_HUMAN_RAW_VIDEO_CATEGORY,
  DIGITAL_HUMAN_SUBTITLE_DEFAULTS,
  DIGITAL_HUMAN_VIDEO_CATEGORY,
  digitalHumanStageLabel,
} from '../../utils/constant/digitalHuman.ts';
import { subtitleStageLabel } from '../../utils/constant/subtitle.ts';
import { burnSubtitlesIntoVideo, type BurnSubtitleStyle } from '../../utils/videoHelper/burnSubtitles.ts';
import { runFfmpeg } from '../../utils/videoHelper/ffmpeg.ts';
import { probeDurationSec } from '../../utils/videoHelper/probe.ts';
import { runIsolatedContext } from '../../utils/requestContext.ts';
import heygemConfig from '../../utils/heygem/heygem.config.ts';
import { getHeygemClient } from '../../utils/heygem/HeygemClient.ts';
import { ensureMountLayout, removeTaskDir } from '../../utils/heygem/heygemMount.ts';
import { tryAcquireLeaderLease, type LeaderLease } from '../../utils/leaderLease.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import {
  buildMulterFile,
  nextUploadPath,
  removeFileQuietly,
  sanitizeFileName,
} from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import { voiceTrainV2SynthesisService } from '../voiceTrainV2/voiceTrainV2Synthesis.service.ts';
import { voiceTrainV2SynthesisTaskRepository } from '../voiceTrainV2/voiceTrainV2SynthesisTask.repository.ts';
import { subtitleTaskService } from '../subtitle/subtitleTask.service.ts';
import { subtitleTaskRepository } from '../subtitle/subtitleTask.repository.ts';
import { digitalHumanAvatarService } from './digitalHumanAvatar.service.ts';
import { digitalHumanTaskRepository } from './digitalHumanTask.repository.ts';
import type { DigitalHumanTaskDocument } from './digitalHumanTask.entity.ts';

const logger = Logger.getInstance();

/** 连续续期失败几次才判定失去 leader 地位（容忍一次 Redis 抖动） */
const MAX_RENEW_FAILURES = 2;

/**
 * 进度分带（总和到 0.97，落库固定 0.98）。
 *
 * 阶段顺序：配音 → 生成字幕（可选）→ 对口型 → 烧录（可选）。
 * 字幕只依赖配音音频，故排在对口型之前 —— ASR 失败/超时不必白等一轮 GPU 合成。
 * 开启烧录时对口型区间收缩（让出 0.30–0.45 给字幕、0.85–0.97 给烧录）；未开启烧录时
 * 字幕阶段不存在，对口型直接从 0.30 推进到 0.97，与历史行为保持一致。
 */
const AUDIO_BAND_START = 0.05;
const AUDIO_BAND_SPAN = 0.25;
const SUBTITLE_BAND_START = 0.3;
const SUBTITLE_BAND_SPAN = 0.15;
const HEYGEM_BAND_START_WITH_BURN = 0.45;
const HEYGEM_BAND_SPAN_WITH_BURN = 0.4;
const HEYGEM_BAND_START_NO_BURN = 0.3;
const HEYGEM_BAND_SPAN_NO_BURN = 0.67;
const BURN_BAND_START = 0.85;

/**
 * 任务样式 → 烧录方法入参：字段逐个读取（Mongoose 子文档的字段不在自身可枚举属性上，
 * 展开 `{ ...task.subtitleOptions }` 会丢字段），缺省走 DIGITAL_HUMAN_SUBTITLE_DEFAULTS。
 */
function resolveBurnStyle(task: DigitalHumanTaskDocument): BurnSubtitleStyle {
  const o = task.subtitleOptions;
  return {
    fontSize: o?.fontSize ?? DIGITAL_HUMAN_SUBTITLE_DEFAULTS.fontSize,
    fontName: o?.fontName ?? DIGITAL_HUMAN_SUBTITLE_DEFAULTS.fontName,
    colorHex: o?.colorHex ?? DIGITAL_HUMAN_SUBTITLE_DEFAULTS.colorHex,
    outline: o?.outline ?? DIGITAL_HUMAN_SUBTITLE_DEFAULTS.outline,
    position: o?.position ?? DIGITAL_HUMAN_SUBTITLE_DEFAULTS.position,
    ...(o?.marginV !== undefined ? { marginV: o.marginV } : {}),
  };
}

/**
 * 数字人合成任务调度器。
 *
 * 与 indexttsDispatcher 同构：本服务跑在 node:cluster 下（生产 CLUSTER_WORKERS=10），
 * 用 Redis 租约把调度循环收敛到唯一进程，避免多个 worker 同时往 duix 容器投递、
 * 同时写挂载目录、同时做全表恢复扫描。
 *
 * 队列就是 Mongo 里 status=pending 的任务集合，调度器用一个在途计数把并发收敛到
 * heygemConfig.concurrency（默认 1）。**不需要 AsyncQueue / 信号量**：租约已保证单调度器，
 * 单进程内的计数即可表达并发上限。
 *
 * 「等配音」期间也会占住在途额度，这是刻意取舍 —— 但把并发放到 2 时，一条任务在 indexTTS
 * 上配音的同时另一条可在 duix 上对口型：duix 容器虽仍是单实例串行，两个 GPU 服务却互不阻塞
 * （两者都是 setTimeout 循环，彼此 await 让出事件循环），吞吐随之提升。
 */
class DigitalHumanDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private lease: LeaderLease | null = null;
  private renewFailures = 0;
  private lastRenewAt = 0;
  /** 调度器并发上限（在途任务数），来自 DIGITALHUMAN_CONCURRENCY */
  private readonly maxConcurrent = heygemConfig.concurrency;
  /** 当前在途任务数（由 claimAndRun 维护，恒 ≤ maxConcurrent） */
  private active = 0;
  private running = false;
  /** 上次卡死任务清理时间（leader 专属，按 taskStaleMs/2 节流） */
  private lastRecoveryAt = 0;

  /** 懒启动（幂等）。首次提交任务时调用 */
  start(): void {
    if (this.running) return;
    if (!heygemConfig.enabled) return;
    this.running = true;
    logger.info(`[DigitalHuman] dispatcher 启动（worker=${getWorkerId()}）`);
    // 调度循环由 HTTP 请求触发，若不隔离，setTimeout 链会继承发起请求的 ALS 上下文，
    // 之后所有写库的 updateBy、新文档的 createBy 都会被填成那个用户的 id。
    runIsolatedContext(() => {
      void this.tick();
    });
  }

  isLeader(): boolean {
    return this.lease !== null;
  }

  /** 是否有在途任务（并发上调后同时跑多条也返回 true） */
  isBusy(): boolean {
    return this.active > 0;
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
      // SHUTDOWN_TIMEOUT_MS 装不下一个长合成任务，等不到就放弃 —— 由下一代的
      // 中断恢复流程把它重新入队（attempts 达上限才判失败）
      const deadline = Date.now() + Math.max(0, SHUTDOWN_TIMEOUT_MS - 1000);
      logger.info('[DigitalHuman] 等待在途合成任务结算…');
      while (this.active > 0 && Date.now() < deadline) {
        await sleep(200);
      }
    }

    if (this.lease) {
      await this.lease.release();
      this.lease = null;
    }
    logger.info('[DigitalHuman] dispatcher 已停止');
  }

  /** 调度循环：选举/续期 → 领取一条 pending 任务 → 执行 */
  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.electAndRenew();
      if (this.lease) await this.recoverStuckTasks();
      // 就绪闸门：duix 不可达（典型是容器正在重启）时不领取任务，让它们留在 pending，
      // 等容器恢复后自动继续 —— 好过领出来立刻烧成 failed。
      const client = getHeygemClient();
      // 一次 tick 把在途额度填满：可同时推进多条任务的流水线（如 A 对口型、B 配音）
      if (this.lease && (await client.canAcceptWork())) {
        await this.claimAndRun();
      }
    } catch (err) {
      logger.error(`[DigitalHuman] 调度循环异常：${err instanceof Error ? err.message : err}`);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), heygemConfig.pollIntervalMs);
    this.timer.unref();
  }

  /** 在并发额度内领取并启动任务，直到配额用尽或队列为空（单线程内同步推进，无竞态） */
  private async claimAndRun(): Promise<void> {
    while (this.running && this.active < this.maxConcurrent) {
      const task = await digitalHumanTaskRepository.claimNextPending(getWorkerId());
      if (!task) return;
      this.active += 1;
      // execute 自身不抛（异常都落到 markFailed），但 finally 派生出的 promise
      // 仍需兜底 catch —— 否则任何逸出异常都会变成 unhandledRejection 杀掉 worker
      void this.execute(task)
        .catch(err => logger.error(`[DigitalHuman] 任务执行异常：${err instanceof Error ? err.message : err}`))
        .finally(() => {
          this.active -= 1;
        });
    }
  }

  /** 首次由调用方按 pollIntervalMs 驱动，故续期也放在这里 */
  private async electAndRenew(): Promise<void> {
    const { leaseTtlMs } = heygemConfig;

    if (!this.lease) {
      this.lease = await tryAcquireLeaderLease({ key: heygemConfig.leaderKey, ttlMs: leaseTtlMs });
      if (this.lease) {
        this.renewFailures = 0;
        this.lastRenewAt = Date.now();
        logger.info(`[DigitalHuman] 获得 leader 租约（worker=${getWorkerId()}）`);
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
      logger.warn(`[DigitalHuman] 租约续期失败（第 ${this.renewFailures} 次），下次重试`);
      return;
    }

    logger.error('[DigitalHuman] 连续续期失败，让出 leader');
    await this.lease.release();
    this.lease = null;
    this.renewFailures = 0;
  }

  /**
   * 卡死任务恢复（仅 leader 调用）。
   *
   * ① 接手租约时立刻清扫**任何 workerId** 的 running 孤儿。依据是「租约保证全机只有一个
   *    调度器」+ 调用方的 `active > 0` 守卫（此刻本进程没有在途任务）—— 因此此刻 Mongo 里
   *    任何 running 行都必然不在执行中，是上一代进程遗留的孤儿。不能只匹配本 workerId：
   *    cluster 重启后 worker id 会重新从 1 分配，旧 id 上的孤儿只能干等到陈旧阈值。
   * ② 周期性按 updatedAt 阈值处理跨进程孤儿（阈值必须大于「配音 + 对口型」的总时长）。
   *
   * 以「重新入队」为主：中断多发生在进程重启/发布期间，此时配音子任务可能已完成或仍在跑，
   * 直接判失败会丢掉可用产物。只有 attempts 达到 TASK_MAX_ATTEMPTS 的才标记失败。
   */
  private async recoverStuckTasks(): Promise<void> {
    if (this.active > 0) return; // 本进程有在途任务，不做任何"恢复"，避免误伤自己
    const interval = Math.max(60_000, Math.floor(heygemConfig.taskStaleMs / 2));
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();

    const requeued = await digitalHumanTaskRepository.requeueOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeued > 0) {
      logger.warn(`[DigitalHuman] 恢复：${requeued} 条中断任务已重新入队（含其他 worker 遗留）`);
    }
    const exhausted = await digitalHumanTaskRepository.failExhaustedOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhausted > 0) {
      logger.warn(`[DigitalHuman] 恢复：${exhausted} 条达重试上限的任务已标记失败`);
    }

    const staleBefore = new Date(Date.now() - heygemConfig.taskStaleMs);
    const requeuedStale = await digitalHumanTaskRepository.requeueStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeuedStale > 0) {
      logger.warn(`[DigitalHuman] 恢复：${requeuedStale} 条超时未更新的任务已重新入队`);
    }
    const exhaustedStale = await digitalHumanTaskRepository.failExhaustedStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhaustedStale > 0) {
      logger.warn(`[DigitalHuman] 恢复：${exhaustedStale} 条超时且达重试上限的任务已标记失败`);
    }
  }

  /** 执行一条已领取的任务；任何异常都落到 markFailed，不向上抛 */
  private async execute(task: DigitalHumanTaskDocument): Promise<void> {
    const taskId = String(task._id);
    // duix 用 code 关联提交与查询，并据此命名产物；用随机 hex 避免不同任务撞车
    const code = crypto.randomUUID().replace(/-/g, '');
    fs.mkdirSync(heygemConfig.runtimeDir, { recursive: true });
    const audio16k = path.join(heygemConfig.runtimeDir, `${code}-audio16k.wav`);
    const outMp4 = path.join(heygemConfig.runtimeDir, `${code}-out.mp4`);
    const burnedMp4 = path.join(heygemConfig.runtimeDir, `${code}-burned.mp4`);

    try {
      await this.reportProgress(taskId, 0.02, 'audio_submit', digitalHumanStageLabel('audio_submit'));

      // ---- ① 配音：复用 IndexTTS 合成链路（不直接调引擎，避免与其调度器争单飞） ----
      // 中断重跑时优先复用已落库的音频产物 / 已提交的配音任务，避免重复消耗 GPU。
      let audio: { fileId: string; url: string; duration: number };
      if (task.audioFileId && task.audioUrl) {
        audio = { fileId: task.audioFileId, url: task.audioUrl, duration: task.audioDuration ?? 0 };
        logger.info(`[DigitalHuman] 复用已完成配音 task=${taskId} file=${audio.fileId}`);
      } else {
        const audioTaskId = await this.ensureAudioTask(task);
        audio = await this.waitForAudio(taskId, audioTaskId);
        await digitalHumanTaskRepository.setAudio(taskId, {
          audioFileId: audio.fileId,
          audioUrl: audio.url,
          audioDuration: audio.duration,
        });
      }

      // ---- ② 归一化为 16k mono wav，供 duix 驱动口型 ----
      const audioFile = await fileService.getById(audio.fileId);
      if (!audioFile) throw new Error('配音产物已失效，请重新提交');
      const rawAudio = path.resolve(fileService.getAbsolutePath(audioFile));
      if (!fs.existsSync(rawAudio)) throw new Error('配音产物文件已丢失，请重新提交');

      await runFfmpeg([
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        rawAudio,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(DIGITAL_HUMAN_AUDIO_SAMPLE_RATE),
        audio16k,
      ]);

      // ---- ③ 生成字幕（可选）：只依赖配音音频，故放在对口型之前 ----
      // 好处：ASR 失败/超时、字幕文件缺失都会在烧掉一轮 GPU 合成之前就失败。
      let sub: { srtFileId: string; srtUrl: string; cueCount: number; srtAbs: string } | null = null;
      if (task.burnSubtitles) {
        const subtitleTaskId = await this.ensureSubtitleTask(task, audio.fileId);
        const done = await this.waitForSubtitle(taskId, subtitleTaskId);
        const srtDoc = await fileService.getById(done.srtFileId);
        if (!srtDoc) throw new Error('字幕产物已失效，请重新提交');
        const srtAbs = path.resolve(fileService.getAbsolutePath(srtDoc));
        if (!fs.existsSync(srtAbs)) throw new Error('字幕文件已丢失，请重新提交');
        sub = { ...done, srtAbs };
      }

      // ---- ④ 解析形象参考视频 ----
      const reference = await digitalHumanAvatarService.resolveReference(task.avatarId, task.userId);
      if ('error' in reference) throw new Error(reference.error);

      // ---- ⑤ 交给 HeyGem 容器产出成片 ----
      ensureMountLayout();
      const heygemStart = task.burnSubtitles ? HEYGEM_BAND_START_WITH_BURN : HEYGEM_BAND_START_NO_BURN;
      const heygemSpan = task.burnSubtitles ? HEYGEM_BAND_SPAN_WITH_BURN : HEYGEM_BAND_SPAN_NO_BURN;
      await this.reportProgress(taskId, heygemStart, 'heygem_submit', digitalHumanStageLabel('heygem_submit'));
      logger.info(
        `[DigitalHuman] 提交 HeyGem task=${taskId} code=${code} ref=${reference.data.absPath}`,
      );

      let lastProgressWriteAt = 0;
      await getHeygemClient().generateVideo(
        { audioPath: audio16k, referenceVideoPath: reference.data.absPath, code, outputPath: outMp4 },
        progress => {
          const now = Date.now();
          const overall = heygemStart + progress.pct * heygemSpan;
          // 进度回调频率远高于 UI 需要，且所有客户端都在轮询这个文档，故节流写库
          if (now - lastProgressWriteAt < heygemConfig.progressMinIntervalMs) return;
          lastProgressWriteAt = now;
          void this.reportProgress(taskId, overall, 'heygem_synth', progress.message);
        },
      );

      // ---- ⑥ 字幕烧录（可选）：把第 ③ 步已生成并校验过的 SRT 烧录进成片 ----
      let finalMp4 = outMp4;
      let rawMp4: string | null = null;
      if (sub) {
        await this.reportProgress(
          taskId,
          BURN_BAND_START,
          'subtitle_burn',
          digitalHumanStageLabel('subtitle_burn'),
        );
        await burnSubtitlesIntoVideo(outMp4, sub.srtAbs, burnedMp4, resolveBurnStyle(task));
        finalMp4 = burnedMp4;
        rawMp4 = outMp4;
        logger.info(`[DigitalHuman] 字幕烧录完成 task=${taskId} 字幕=${sub.cueCount} 条`);
      }

      // ---- ⑦ 落 file 表 ----
      await this.reportProgress(taskId, 0.98, 'persist', digitalHumanStageLabel('persist'));
      const result = await this.persistResult(
        task,
        reference.data.avatar.name,
        finalMp4,
        taskId,
        audio,
        rawMp4,
        sub,
      );
      logger.info(
        `[DigitalHuman] 合成完成 task=${taskId} file=${result.fileId} 时长=${result.duration.toFixed(2)}s`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[DigitalHuman] 合成失败 task=${taskId}：${message}`);
      await digitalHumanTaskRepository
        .markFailed(taskId, message, new Date())
        .catch(markErr => logger.error(`[DigitalHuman] 标记失败态也失败了 task=${taskId}：${markErr}`));
    } finally {
      // 运行期临时文件与挂载任务目录无论成败都清掉（落进 file 表的是 uploads 下的拷贝）
      removeFileQuietly(audio16k);
      removeFileQuietly(outMp4);
      removeFileQuietly(burnedMp4);
      removeTaskDir(code);
    }
  }

  /**
   * 确保有一个可用的配音任务：优先复用 task.audioTaskId。
   *
   * 中断（重启/发布）后重跑时，若不复用就会再烧一次完整 GPU 合成；而远端作业本身以
   * clientJobId(= 数字人任务 id) 幂等，续用同一个配音任务即可命中同一作业。
   * 只有配音任务不存在或已 failed 时才重新提交。
   */
  private async ensureAudioTask(task: DigitalHumanTaskDocument): Promise<string> {
    const taskId = String(task._id);
    const existing = task.audioTaskId;
    if (existing) {
      const doc = await voiceTrainV2SynthesisTaskRepository.findById(existing);
      // pending/running 续等、success 会在 waitForAudio 里立即返回，只有 failed 需要重投
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
    const audioTaskId = submitted.data.taskId;
    await digitalHumanTaskRepository.setAudio(taskId, { audioTaskId });
    logger.info(`[DigitalHuman] 配音已提交 task=${taskId} audioTask=${audioTaskId}`);
    return audioTaskId;
  }

  /**
   * 轮询配音任务直到成功/失败。
   *
   * 配音走 indexTTS 自己的调度器，这里只做等待与进度映射（0.05–0.45）。
   * 超时取 heygemConfig.audioTimeoutMs —— 必须 ≥ INDEXTTS_JOB_TIMEOUT_MS。
   */
  private async waitForAudio(
    taskId: string,
    audioTaskId: string,
  ): Promise<{ fileId: string; url: string; duration: number }> {
    const deadline = Date.now() + heygemConfig.audioTimeoutMs;
    let lastWriteAt = 0;

    while (Date.now() < deadline) {
      const doc = await voiceTrainV2SynthesisTaskRepository.findById(audioTaskId);
      if (!doc) throw new Error('配音任务不存在（可能已被清理），请重新提交');

      if (doc.status === 'success') {
        if (!doc.resultFileId) throw new Error('配音任务已完成但未产出音频，请重新提交');
        return { fileId: doc.resultFileId, url: doc.resultUrl, duration: doc.duration };
      }
      if (doc.status === 'failed') {
        throw new Error(`配音失败：${doc.message || '未知原因'}`);
      }

      const now = Date.now();
      if (now - lastWriteAt >= heygemConfig.progressMinIntervalMs) {
        lastWriteAt = now;
        const pct = AUDIO_BAND_START + Math.max(0, Math.min(1, doc.progress)) * AUDIO_BAND_SPAN;
        await this.reportProgress(
          taskId,
          pct,
          'audio_synth',
          // 透传配音任务自身的 message（形如「IndexTTS 合成中 · 段落 12/40」）。
          // 只显示阶段标签的话，长文本合成期间前端会看到一句恒定不变的提示，像卡死。
          `配音合成中 · ${doc.message || indexttsStageLabel(doc.stage)}`,
        );
      }
      await sleep(heygemConfig.pollIntervalMs);
    }
    throw new Error('配音超时，请缩短文案后重试');
  }

  /**
   * 确保有一个可用的字幕生成任务（对配音音频跑 ASR）：优先复用 task.subtitleTaskId。
   *
   * 与 ensureAudioTask 同思路 —— 中断（重启/发布）后重跑时复用它，避免对同一段音频
   * 重复消耗一次转写（云端 ASR 按时长计费）；只有子任务不存在或已 failed 才重新提交。
   */
  private async ensureSubtitleTask(
    task: DigitalHumanTaskDocument,
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
    await digitalHumanTaskRepository.setSubtitle(taskId, { subtitleTaskId });
    logger.info(`[DigitalHuman] 字幕已提交 task=${taskId} subtitleTask=${subtitleTaskId}`);
    return subtitleTaskId;
  }

  /**
   * 轮询字幕生成任务直到成功/失败，成功时返回 SRT 产物并回写到数字人任务。
   *
   * 转写走 subtitleDispatcher 的队列与并发约束，这里只做等待与进度映射（0.30–0.45）；
   * 超时取 heygemConfig.subtitleTimeoutMs —— 必须 ≥ SUBTITLE_TASK_STALE_MS。
   */
  private async waitForSubtitle(
    taskId: string,
    subtitleTaskId: string,
  ): Promise<{ srtFileId: string; srtUrl: string; cueCount: number }> {
    const deadline = Date.now() + heygemConfig.subtitleTimeoutMs;
    let lastWriteAt = 0;

    while (Date.now() < deadline) {
      const doc = await subtitleTaskRepository.findById(subtitleTaskId);
      if (!doc) throw new Error('字幕任务不存在（可能已被清理），请重新提交');

      if (doc.status === 'success') {
        if (!doc.srtFileId) throw new Error('字幕任务已完成但未产出字幕，请重新提交');
        const srt = {
          srtFileId: doc.srtFileId,
          srtUrl: doc.srtUrl,
          cueCount: doc.cueCount ?? 0,
        };
        await digitalHumanTaskRepository.setSubtitle(taskId, srt);
        return srt;
      }
      if (doc.status === 'failed') {
        throw new Error(`字幕生成失败：${doc.message || '未知原因'}`);
      }

      const now = Date.now();
      if (now - lastWriteAt >= heygemConfig.progressMinIntervalMs) {
        lastWriteAt = now;
        const pct = SUBTITLE_BAND_START + Math.max(0, Math.min(1, doc.progress)) * SUBTITLE_BAND_SPAN;
        await this.reportProgress(
          taskId,
          pct,
          'subtitle_asr',
          // 与配音阶段同理：透传子任务 message，否则长音频转写期间提示恒定不变，像卡死
          `生成字幕中 · ${doc.message || subtitleStageLabel(doc.stage)}`,
        );
      }
      await sleep(heygemConfig.pollIntervalMs);
    }
    throw new Error('字幕生成超时，请缩短文案后重试');
  }

  /**
   * 把成片落进 file 表，并标记任务成功。
   *
   * finalMp4 是最终交付物（开启烧录时为带字幕版本）；rawMp4 非空时另存一份
   * 烧录前的原始成片，便于用户拿无字幕版本或后续换样式重烧。
   */
  private async persistResult(
    task: DigitalHumanTaskDocument,
    avatarName: string,
    finalMp4: string,
    taskId: string,
    audio: { fileId: string; url: string; duration: number },
    rawMp4: string | null = null,
    subtitle: { srtFileId: string; srtUrl: string; cueCount: number } | null = null,
  ): Promise<{ fileId: string; duration: number }> {
    const destAbs = nextUploadPath(fileConfig.uploadDir, '.mp4');
    let rawDestAbs: string | null = null;
    try {
      fs.copyFileSync(finalMp4, destAbs);
      const duration = await probeDurationSec(destAbs);
      const { created } = await fileService.upload(
        buildMulterFile(destAbs, `${sanitizeFileName(avatarName, 'digital-human')}.mp4`, 'video/mp4'),
        {
          category: DIGITAL_HUMAN_VIDEO_CATEGORY,
          ...(task.userId ? { createBy: task.userId } : {}),
          metadata: { taskId, avatarId: task.avatarId, duration, burnSubtitles: task.burnSubtitles === true },
        },
      );
      const fileId = String(created._id);
      const resultUrl = `/api/files/${fileId}/download`;

      let rawVideoFileId = '';
      let rawVideoUrl = '';
      if (rawMp4) {
        rawDestAbs = nextUploadPath(fileConfig.uploadDir, '.mp4');
        fs.copyFileSync(rawMp4, rawDestAbs);
        const rawUploaded = await fileService.upload(
          buildMulterFile(rawDestAbs, `${sanitizeFileName(avatarName, 'digital-human')}-raw.mp4`, 'video/mp4'),
          {
            category: DIGITAL_HUMAN_RAW_VIDEO_CATEGORY,
            ...(task.userId ? { createBy: task.userId } : {}),
            metadata: { taskId, avatarId: task.avatarId, duration },
          },
        );
        rawVideoFileId = String(rawUploaded.created._id);
        rawVideoUrl = `/api/files/${rawVideoFileId}/download`;
      }

      await digitalHumanTaskRepository.markSuccess(taskId, {
        resultFileId: fileId,
        resultUrl,
        videoDuration: duration,
        audioFileId: audio.fileId,
        audioUrl: audio.url,
        audioDuration: audio.duration,
        ...(subtitle
          ? { srtFileId: subtitle.srtFileId, srtUrl: subtitle.srtUrl, cueCount: subtitle.cueCount }
          : {}),
        ...(rawVideoFileId ? { rawVideoFileId, rawVideoUrl } : {}),
        finishedAt: new Date(),
      });
      return { fileId, duration };
    } catch (err) {
      removeFileQuietly(destAbs);
      if (rawDestAbs) removeFileQuietly(rawDestAbs);
      throw err;
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
      digitalHumanTaskRepository
        .updateProgress(taskId, { progress, stage, message })
        .catch(() => {
          // 进度上报失败不影响合成本身
        }),
    );
  }
}

export const digitalHumanDispatcher = new DigitalHumanDispatcher();

// 关机钩子：与 IndexTTS/视频队列同样的排空语义
registerShutdownHook(() => digitalHumanDispatcher.stop());
