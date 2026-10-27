import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../../utils/Logger.ts';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { registerShutdownHook } from '../../utils/shutdownHooks.ts';
import { SHUTDOWN_TIMEOUT_MS, TASK_MAX_ATTEMPTS } from '../../utils/constant/ClusterConstants.ts';
import {
  SUBTITLE_SRT_CATEGORY,
  SUBTITLE_SRT_MIME,
  subtitleStageLabel,
} from '../../utils/constant/subtitle.ts';
import { parseSrt } from '../../utils/videoHelper/srt.ts';
import { probeDurationSec } from '../../utils/videoHelper/probe.ts';
import { extractAudioToWav } from '../../utils/videoHelper/extractAudio.ts';
import { runIsolatedContext } from '../../utils/requestContext.ts';
import { tryAcquireLeaderLease, type LeaderLease } from '../../utils/leaderLease.ts';
import { transcribeToSrt } from '../../utils/asr/index.ts';
import asrConfig from '../../utils/asr/asr.config.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import {
  buildMulterFile,
  nextUploadPath,
  removeFileQuietly,
  sanitizeFileName,
} from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import { removeExtractedAudio, resolveExtractedAudio } from './subtitleVideo.helper.ts';
import { subtitleTaskRepository } from './subtitleTask.repository.ts';
import type { SubtitleTaskDocument } from './subtitleTask.entity.ts';

const logger = Logger.getInstance();

/** 连续续期失败几次才判定失去 leader 地位（容忍一次 Redis 抖动） */
const MAX_RENEW_FAILURES = 2;

/** 进度区间：解析音频 0.05 / 转写 0.10→0.55（由 provider 上报）/ 落库 0.90 */
const PROGRESS_RESOLVE = 0.05;
const PROGRESS_ASR_START = 0.1;
const PROGRESS_PERSIST = 0.9;

/**
 * 字幕生成任务调度器。
 *
 * 与 indexttsDispatcher / digitalHumanDispatcher 同构：本服务跑在 node:cluster 下
 * （生产 CLUSTER_WORKERS=10），用 Redis 租约把调度循环收敛到唯一进程 —— 否则 10 个 worker
 * 会同时扫描队列、同时做全表恢复、同时写给同一批任务进度。
 *
 * 队列就是 Mongo 里 status=pending 的任务集合，调度器用一个在途计数把并发收敛到
 * asrConfig.scheduler.concurrency。与数字人不同的是这里**没有 GPU 闸门**：转写走云端
 * （或外部 HTTP 服务），不需要等待本机模型就绪。
 */
class SubtitleDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private lease: LeaderLease | null = null;
  private renewFailures = 0;
  private lastRenewAt = 0;
  /** 调度器并发上限（在途任务数），来自 SUBTITLE_CONCURRENCY */
  private readonly maxConcurrent = asrConfig.scheduler.concurrency;
  /** 当前在途任务数（由 claimAndRun 维护，恒 ≤ maxConcurrent） */
  private active = 0;
  private running = false;
  /** 上次卡死任务清理时间（leader 专属，按 taskStaleMs/2 节流） */
  private lastRecoveryAt = 0;

  /** 懒启动（幂等）。首次提交任务时调用 */
  start(): void {
    if (this.running) return;
    if (!asrConfig.enabled) return;
    this.running = true;
    logger.info(`[Subtitle] dispatcher 启动（worker=${getWorkerId()}）`);
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
      // 转写可能数十秒到数分钟，超窗由下一次启动的中断恢复流程重新入队
      const deadline = Date.now() + Math.max(0, SHUTDOWN_TIMEOUT_MS - 1000);
      logger.info('[Subtitle] 等待在途转写任务结算…');
      while (this.active > 0 && Date.now() < deadline) {
        await sleep(200);
      }
    }

    if (this.lease) {
      await this.lease.release();
      this.lease = null;
    }
    logger.info('[Subtitle] dispatcher 已停止');
  }

  /** 调度循环：选举/续期 → 领取 pending 任务 → 执行 */
  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.electAndRenew();
      if (this.lease) await this.recoverStuckTasks();
      if (this.lease) await this.claimAndRun();
    } catch (err) {
      logger.error(`[Subtitle] 调度循环异常：${err instanceof Error ? err.message : err}`);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), asrConfig.scheduler.pollIntervalMs);
    this.timer.unref();
  }

  /** 在并发额度内领取并启动任务，直到配额用尽或队列为空（单线程内同步推进，无竞态） */
  private async claimAndRun(): Promise<void> {
    while (this.running && this.active < this.maxConcurrent) {
      const task = await subtitleTaskRepository.claimNextPending(getWorkerId());
      if (!task) return;
      this.active += 1;
      // execute 自身不抛（异常都落到 markFailed），但 finally 派生出的 promise
      // 仍需兜底 catch —— 否则任何逸出异常都会变成 unhandledRejection 杀掉 worker
      void this.execute(task)
        .catch(err => logger.error(`[Subtitle] 任务执行异常：${err instanceof Error ? err.message : err}`))
        .finally(() => {
          this.active -= 1;
        });
    }
  }

  /** 首次由调用方按 pollIntervalMs 驱动，故续期也放在这里 */
  private async electAndRenew(): Promise<void> {
    const { leaseTtlMs } = asrConfig.scheduler;

    if (!this.lease) {
      this.lease = await tryAcquireLeaderLease({ key: asrConfig.scheduler.leaderKey, ttlMs: leaseTtlMs });
      if (this.lease) {
        this.renewFailures = 0;
        this.lastRenewAt = Date.now();
        logger.info(`[Subtitle] 获得 leader 租约（worker=${getWorkerId()}）`);
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
      logger.warn(`[Subtitle] 租约续期失败（第 ${this.renewFailures} 次），下次重试`);
      return;
    }

    logger.error('[Subtitle] 连续续期失败，让出 leader');
    await this.lease.release();
    this.lease = null;
    this.renewFailures = 0;
  }

  /**
   * 卡死任务恢复（仅 leader 调用）。
   *
   * ① 接手租约时立刻清扫**任何 workerId** 的 running 孤儿（此刻本进程没有在途任务，
   *    Mongo 里的 running 行必然是上一代进程遗留）。
   * ② 周期性按 updatedAt 阈值处理跨进程孤儿（阈值须大于一次完整转写耗时）。
   *
   * 以「重新入队」为主：中断多发生在进程重启/发布期间，直接判失败会丢掉可用结果。
   * 只有 attempts 达到 TASK_MAX_ATTEMPTS 的才标记失败。
   */
  private async recoverStuckTasks(): Promise<void> {
    if (this.active > 0) return; // 本进程有在途任务，不做任何"恢复"，避免误伤自己
    const interval = Math.max(60_000, Math.floor(asrConfig.scheduler.taskStaleMs / 2));
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();

    const requeued = await subtitleTaskRepository.requeueOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeued > 0) {
      logger.warn(`[Subtitle] 恢复：${requeued} 条中断任务已重新入队（含其他 worker 遗留）`);
    }
    const exhausted = await subtitleTaskRepository.failExhaustedOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhausted > 0) {
      logger.warn(`[Subtitle] 恢复：${exhausted} 条达重试上限的任务已标记失败`);
    }

    const staleBefore = new Date(Date.now() - asrConfig.scheduler.taskStaleMs);
    const requeuedStale = await subtitleTaskRepository.requeueStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeuedStale > 0) {
      logger.warn(`[Subtitle] 恢复：${requeuedStale} 条超时未更新的任务已重新入队`);
    }
    const exhaustedStale = await subtitleTaskRepository.failExhaustedStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhaustedStale > 0) {
      logger.warn(`[Subtitle] 恢复：${exhaustedStale} 条超时且达重试上限的任务已标记失败`);
    }
  }

  /** 执行一条已领取的任务；任何异常都落到 markFailed，不向上抛 */
  private async execute(task: SubtitleTaskDocument): Promise<void> {
    const taskId = String(task._id);
    let srtAbs: string | null = null;
    let srtRegistered = false;
    let lastProgressWriteAt = 0;

    try {
      // ---- ① 解析源音频 ----
      await this.reportProgress(taskId, PROGRESS_RESOLVE, 'resolve_audio', subtitleStageLabel('resolve_audio'));
      const sourceFile = await fileService.getById(task.audioFileId);
      if (!sourceFile) throw new Error('源媒体文件记录不存在（可能已被删除），请重新提交');
      const sourceAbs = path.resolve(fileService.getAbsolutePath(sourceFile));
      if (!fs.existsSync(sourceAbs)) throw new Error('源媒体文件已丢失，请重新上传');

      // 音频任务直接用源文件；视频任务用提交时提取的临时音频。
      // 临时音频缺失时兜底重提：源视频是持久保留的 file 记录，重提只是几秒 CPU，
      // 而不兜底的话 attempts>1 的续跑会必然以「音频文件已丢失」失败。
      let audioAbs = sourceAbs;
      if (task.extractedAudioPath) {
        audioAbs = resolveExtractedAudio(fileConfig.uploadDir, task.extractedAudioPath);
        if (!fs.existsSync(audioAbs)) {
          logger.warn(`[Subtitle] 临时音频缺失，改由源视频重新提取 task=${taskId}`);
          await this.reportProgress(
            taskId,
            PROGRESS_RESOLVE,
            'extract_audio',
            subtitleStageLabel('extract_audio'),
          );
          fs.mkdirSync(path.dirname(audioAbs), { recursive: true });
          await extractAudioToWav(sourceAbs, audioAbs);
        }
      }

      // ---- ② ASR 转写（本地 Whisper 优先 + 云端讯飞兜底） ----
      await this.reportProgress(taskId, PROGRESS_ASR_START, 'asr', subtitleStageLabel('asr'));
      const { srt, provider } = await transcribeToSrt(audioAbs, {
        language: task.language,
        // 幂等键：Whisper 服务按 taskId 去重，中断重排后续跑不会重复识别
        clientJobId: taskId,
        onProgress: (pct, stage, message) => {
          const now = Date.now();
          // 进度回调频率远高于 UI 需要，且所有客户端都在轮询这个文档，故节流写库
          if (now - lastProgressWriteAt < asrConfig.scheduler.progressMinIntervalMs) return;
          lastProgressWriteAt = now;
          void this.reportProgress(taskId, pct, stage, message);
        },
      });

      const cueCount = parseSrt(srt).length;
      if (!srt.trim() || cueCount === 0) {
        throw new Error('未识别到有效字幕，请确认音频包含清晰人声后重试');
      }

      // ---- ③ 落 SRT 到 file 表 ----
      await this.reportProgress(taskId, PROGRESS_PERSIST, 'persist', subtitleStageLabel('persist'));
      const audioDuration = await probeDurationSec(audioAbs).catch(() => 0);
      srtAbs = nextUploadPath(fileConfig.uploadDir, '.srt');
      fs.writeFileSync(srtAbs, srt, 'utf8');

      const baseName = path.basename(task.originalName, path.extname(task.originalName));
      const { created } = await fileService.upload(
        buildMulterFile(srtAbs, `${sanitizeFileName(baseName, 'subtitle')}.srt`, SUBTITLE_SRT_MIME),
        {
          category: SUBTITLE_SRT_CATEGORY,
          ...(task.userId ? { createBy: task.userId } : {}),
          metadata: { taskId, provider, cueCount, audioDuration },
        },
      );
      srtRegistered = true;
      const srtFileId = String(created._id);

      await subtitleTaskRepository.markSuccess(taskId, {
        srtFileId,
        srtUrl: `/api/files/${srtFileId}/download`,
        cueCount,
        audioDuration,
        provider,
        finishedAt: new Date(),
      });
      logger.info(
        `[Subtitle] 生成完成 task=${taskId} provider=${provider} 字幕=${cueCount} 条 file=${srtFileId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Subtitle] 生成失败 task=${taskId}：${message}`);
      await subtitleTaskRepository
        .markFailed(taskId, message, new Date())
        .catch(markErr => logger.error(`[Subtitle] 标记失败态也失败了 task=${taskId}：${markErr}`));
    } finally {
      // 未成功注册的临时 SRT 清掉；已注册的由 file 记录持有，不能删
      if (!srtRegistered && srtAbs) removeFileQuietly(srtAbs);
      // 视频任务的临时音频属中间产物：任务已进入终态（成功/失败），清掉音频与其 .subtitle/<uuid> 目录。
      // 进程被杀时本 finally 不执行 —— 那正是我们要的：临时音频保留下来供续跑直接复用。
      if (task.extractedAudioPath) {
        removeExtractedAudio(fileConfig.uploadDir, task.extractedAudioPath, msg =>
          logger.warn(`[Subtitle] 清理临时音频失败（${task.extractedAudioPath}）：${msg}`),
        );
      }
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
      subtitleTaskRepository.updateProgress(taskId, { progress, stage, message }).catch(() => {
        // 进度上报失败不影响转写本身
      }),
    );
  }
}

export const subtitleDispatcher = new SubtitleDispatcher();

// 关机钩子：与 IndexTTS/数字人/视频队列同样的排空语义
registerShutdownHook(() => subtitleDispatcher.stop());
