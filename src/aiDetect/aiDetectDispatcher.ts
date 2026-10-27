import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../../utils/Logger.ts';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { registerShutdownHook } from '../../utils/shutdownHooks.ts';
import { SHUTDOWN_TIMEOUT_MS, TASK_MAX_ATTEMPTS } from '../../utils/constant/ClusterConstants.ts';
import {
  AI_DETECT_ASR_AUDIO_CATEGORY,
  AI_DETECT_ASR_AUDIO_MIME,
  AI_DETECT_FRAME_CATEGORY,
  AI_DETECT_FRAME_MIME,
  aiDetectStageLabel,
} from '../../utils/constant/aiDetect.ts';
import { detectScenes } from '../../utils/videoHelper/sceneDetect.ts';
import { detectBlackFrames } from '../../utils/videoHelper/blackDetect.ts';
import { extractFrame } from '../../utils/videoHelper/frameExtract.ts';
import { extractAudioClip } from '../../utils/videoHelper/audioClip.ts';
import { parseSrt, type SrtCue } from '../../utils/videoHelper/srt.ts';
import { probeDurationMs } from '../../utils/videoHelper/probe.ts';
import { runIsolatedContext } from '../../utils/requestContext.ts';
import { tryAcquireLeaderLease, type LeaderLease } from '../../utils/leaderLease.ts';
import aiDetectConfig from '../../utils/aiDetect/aiDetect.config.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
// 转写不在本进程内跑：复用 subtitle 模块的 Whisper 链路（提交子任务 + 轮询），
// 与其 leader 调度器、并发闸门共用一套算力 —— 与 videoPipelineV2 / digitalHuman 的编排口径一致。
import { subtitleTaskService } from '../subtitle/subtitleTask.service.ts';
import { subtitleTaskRepository } from '../subtitle/subtitleTask.repository.ts';
import {
  buildMulterFile,
  nextUploadPath,
  removeFileQuietly,
} from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import { aiDetectTaskRepository } from './aiDetectTask.repository.ts';
import { aiDetectFrameTaskRepository } from './aiDetectFrameTask.repository.ts';
import { aiDetectAsrTaskRepository } from './aiDetectAsrTask.repository.ts';
import {
  groupCuesByScene,
  offsetCues,
  planAsrChunks,
  resolveChunkFileName,
} from './aiDetectAsr.helper.ts';
import {
  resolveFrameFileName,
  resolveSceneFrameTimes,
  resolveSourceStem,
} from './aiDetectFrame.helper.ts';
import { applyHeadTailBlackScenes } from './aiDetectBlack.helper.ts';
import type { AiDetectTaskDocument, IAiDetectBlackSceneMark } from './aiDetectTask.entity.ts';
import type {
  AiDetectFrameKind,
  AiDetectFrameTaskDocument,
  IAiDetectFrame,
  IAiDetectSceneFrames,
} from './aiDetectFrameTask.entity.ts';
import type {
  AiDetectAsrTaskDocument,
  IAiDetectAsrSegment,
} from './aiDetectAsrTask.entity.ts';

const logger = Logger.getInstance();

/** 连续续期失败几次才判定失去 leader 地位（容忍一次 Redis 抖动） */
const MAX_RENEW_FAILURES = 2;

/**
 * 进度档位（场景切分）。
 *
 * 场景检测是**一次远程 HTTP 调用**（独立 scenedetect 容器）：检测跑完才返回 JSON，
 * 中间不回报任何进度（`show_progress=False`，进度条也只写容器 stderr）。所以这里只能给粗粒度档位，
 * 而不是真实百分比 —— 客户端按阶段展示即可，不要当成线性进度。
 * 首尾黑帧检测（可选）夹在检测与落库之间，故开启时是五档、不开时四档。
 */
const PROGRESS_RESOLVE = 0.05;
const PROGRESS_DETECT = 0.1;
const PROGRESS_BLACK = 0.5;
const PROGRESS_PERSIST = 0.9;

/**
 * 进度档位（场景抽帧）。
 *
 * 抽帧与场景检测不同：它是「3 × 场景数」次独立子进程调用，每完成一个场景就能推进一格，
 * 因此给的是**真实百分比**（0.1 → 0.9 之间按已处理场景数线性插值）。
 */
const PROGRESS_EXTRACT = 0.1;
const PROGRESS_EXTRACT_END = 0.9;

/**
 * 进度档位（场景转写）。
 *
 * 同样是真实百分比，但推进单位是**音频块**而不是场景：每块要走「抽音频 → 提字幕子任务 → 等转写」，
 * 块内等待期间由 waitForSubtitle 按 progressMinIntervalMs 透传子任务进度。
 */
const PROGRESS_ASR = 0.1;
const PROGRESS_ASR_END = 0.9;

/** 帧图片的扩展名（抽帧只输出 jpg，登记 file 表时也按 image/jpeg） */
const FRAME_EXT = '.jpg';

/** 音频块的扩展名（转写中间产物：16k 单声道 wav） */
const AUDIO_EXT = '.wav';

/** 转写任务里一个已落盘/已登记的音频块（失败时按它回滚） */
interface ProducedAudioChunk {
  /** 落盘绝对路径 */
  abs: string;
  /** 登记后的 file 记录 id；空串表示还没登记 */
  fileId: string;
}

/** 抽帧过程中一张「已落盘待登记」的帧 */
interface PendingFrame {
  /** 落盘绝对路径（登记后仍需要它：失败回滚要删磁盘文件） */
  abs: string;
  /** 对外文件名（进 file 表的 originalName，也是下载时的文件名） */
  fileName: string;
  /** 帧位 */
  kind: AiDetectFrameKind;
  /** 抽帧时间点（ms） */
  timeMs: number;
  /** 登记后的 file 记录 id；空串表示还没登记（回滚时据此决定要不要假删除记录） */
  fileId: string;
}

/** 三条队列的标识：调度器按它取仓储、取额度、取进度快照 */
export type AiDetectQueueKind = 'scene' | 'frames' | 'asr';

/**
 * 三条队列仓储在 dispatcher **进度上报**处的最小公共面。
 *
 * 三个仓储的 updateProgress 签名完全一致，只有落库的表不同，故用一个结构类型统一起来，
 * 避免每条进度上报都写一遍分支。领取（claimNextPending）与失败落库刻意不放进这里：
 * 前者各队列的文档类型不同、要与各自的执行体配对，后者各写各的更直白。
 */
interface AiDetectProgressWriter {
  updateProgress(
    id: string,
    data: { progress: number; stage: string; message: string },
  ): Promise<unknown>;
}

/**
 * 场景切分 / 场景抽帧 / 场景转写的任务调度器。
 *
 * 与 subtitleDispatcher / digitalHumanDispatcher 同构：本服务跑在 node:cluster 下
 * （生产 CLUSTER_WORKERS=10），用 Redis 租约把调度循环收敛到唯一进程 —— 否则 10 个 worker
 * 会同时扫描队列、同时做全表恢复、同时写给同一批任务进度。
 *
 * 它管**三条彼此独立的队列**（场景切分 aiDetectTasks / 场景抽帧 aiDetectFrameTasks /
 * 场景转写 aiDetectAsrTasks）：各在自己的表上 FIFO 领取、各有各的在途上限与进度快照，
 * 填满一条的额度不会占用另一条。调度节奏（轮询、进度节流、租约、陈旧阈值）则是共用的 ——
 * 租约表达的是「本机只有一个执行者」，与有几条队列无关。
 *
 * 与数字人的区别：**没有 GPU 闸门**。检测跑在独立的 scenedetect HTTP 容器、抽帧是本机 ffmpeg
 * 子进程（均纯 CPU）；转写则完全外包给 subtitle 模块（本进程只切块、提子任务、轮询、归并），
 * 故本进程内不持有任何模型。
 */
class AiDetectDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private lease: LeaderLease | null = null;
  private renewFailures = 0;
  private lastRenewAt = 0;

  /** 各队列的仓储（只用于进度上报这类签名一致的操作；领取与失败落库按队列显式处理） */
  private readonly repositories = {
    scene: aiDetectTaskRepository,
    frames: aiDetectFrameTaskRepository,
    asr: aiDetectAsrTaskRepository,
  } as const;

  /** 各队列的并发上限（在途任务数），分别来自 AI_DETECT_CONCURRENCY / …_FRAME_… / …_ASR_… */
  private readonly maxConcurrents: Record<AiDetectQueueKind, number> = {
    scene: aiDetectConfig.scheduler.concurrency,
    frames: aiDetectConfig.frames.concurrency,
    asr: aiDetectConfig.asr.concurrency,
  };

  /** 各队列当前在途任务数（由各自的 claimXxx 维护，恒 ≤ maxConcurrents[kind]） */
  private readonly activeCounts: Record<AiDetectQueueKind, number> = {
    scene: 0,
    frames: 0,
    asr: 0,
  };

  /** 各队列最近一次的进度快照（各自的 /engine/status 展示用） */
  private readonly lastProgress: Record<AiDetectQueueKind, { pct: number; stage: string } | null> = {
    scene: null,
    frames: null,
    asr: null,
  };

  private running = false;
  /** 上次卡死任务清理时间（leader 专属，按 taskStaleMs/2 节流） */
  private lastRecoveryAt = 0;
  /**
   * 抽帧进度写库节流：上次写库时间**按 taskId 记**。
   *
   * 不能用一个进程级时间戳：抽帧额度可配（AI_DETECT_FRAME_CONCURRENCY > 1 时本进程会同时跑多条
   * 抽帧任务），共用时间戳会让并发的几条任务互相压掉对方的进度写。条目在任务收尾时删除
   * （见 executeFrameTask），故表的大小不超过在途抽帧任务数。
   */
  private readonly lastExtractProgressAt = new Map<string, number>();

  /** 懒启动（幂等）。首次提交任务时调用 */
  start(): void {
    if (this.running) return;
    if (!aiDetectConfig.enabled) return;
    this.running = true;
    logger.info(`[AiDetect] dispatcher 启动（worker=${getWorkerId()}）`);
    // 调度循环由 HTTP 请求触发，若不隔离，setTimeout 链会继承发起请求的 ALS 上下文，
    // 之后所有写库的 updateBy、新文档的 createBy 都会被填成那个用户的 id。
    runIsolatedContext(() => {
      void this.tick();
    });
  }

  isLeader(): boolean {
    return this.lease !== null;
  }

  /** 指定队列的当前在途任务数 */
  getActiveCount(kind: AiDetectQueueKind): number {
    return this.activeCounts[kind];
  }

  /** 指定队列的并发上限（各自经配置规整后的实际值） */
  getConcurrency(kind: AiDetectQueueKind): number {
    return this.maxConcurrents[kind];
  }

  /** 指定队列最近一次的进度快照 */
  getLastProgress(kind: AiDetectQueueKind): { pct: number; stage: string } | null {
    return this.lastProgress[kind];
  }

  /** 各队列在途任务数之和（关机等待用） */
  private get totalActive(): number {
    return this.activeCounts.scene + this.activeCounts.frames + this.activeCounts.asr;
  }

  /** 优雅关闭：停掉循环 → 等三条队列的在途任务都结算 → 释放租约 */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.totalActive > 0) {
      // 检测/抽帧/转写都可能数十秒到数分钟，超窗由下一次启动的中断恢复流程重新入队
      const deadline = Date.now() + Math.max(0, SHUTDOWN_TIMEOUT_MS - 1000);
      logger.info('[AiDetect] 等待在途任务结算…');
      while (this.totalActive > 0 && Date.now() < deadline) {
        await sleep(200);
      }
    }

    if (this.lease) {
      await this.lease.release();
      this.lease = null;
    }
    logger.info('[AiDetect] dispatcher 已停止');
  }

  /** 调度循环：选举/续期 → 分别领取三条队列的 pending 任务 → 执行 */
  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.electAndRenew();
      if (this.lease) await this.recoverStuckTasks();
      if (this.lease) await this.claimAndRun();
    } catch (err) {
      logger.error(`[AiDetect] 调度循环异常：${err instanceof Error ? err.message : err}`);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), aiDetectConfig.scheduler.pollIntervalMs);
    this.timer.unref();
  }

  /**
   * 三条队列各自在**自己的额度内**领取并启动任务。
   *
   * 三段顺序 await、各用各的计数器，所以填满一条的额度不会影响另一条 ——
   * 这正是把三类任务分表分队列的目的。段内单线程推进，无竞态。
   */
  private async claimAndRun(): Promise<void> {
    await this.claimScene();
    await this.claimFrames();
    await this.claimAsr();
  }

  /** 在场景切分额度内领取，直到配额用尽或队列为空 */
  private async claimScene(): Promise<void> {
    while (this.running && this.activeCounts.scene < this.maxConcurrents.scene) {
      const task = await aiDetectTaskRepository.claimNextPending(getWorkerId());
      if (!task) return;
      this.activeCounts.scene += 1;
      // 执行体自身不抛（异常都落到 markFailed），但 finally 派生出的 promise
      // 仍需兜底 catch —— 否则任何逸出异常都会变成 unhandledRejection 杀掉 worker
      void this.executeScene(task)
        .catch((err) => logger.error(`[AiDetect] 任务执行异常：${err instanceof Error ? err.message : err}`))
        .finally(() => {
          this.activeCounts.scene -= 1;
        });
    }
  }

  /** 在抽帧额度内领取，直到配额用尽或队列为空 */
  private async claimFrames(): Promise<void> {
    while (this.running && this.activeCounts.frames < this.maxConcurrents.frames) {
      const task = await aiDetectFrameTaskRepository.claimNextPending(getWorkerId());
      if (!task) return;
      this.activeCounts.frames += 1;
      void this.executeFrameTask(task)
        .catch((err) => logger.error(`[AiDetect] 任务执行异常：${err instanceof Error ? err.message : err}`))
        .finally(() => {
          this.activeCounts.frames -= 1;
        });
    }
  }

  /** 在转写额度内领取，直到配额用尽或队列为空 */
  private async claimAsr(): Promise<void> {
    while (this.running && this.activeCounts.asr < this.maxConcurrents.asr) {
      const task = await aiDetectAsrTaskRepository.claimNextPending(getWorkerId());
      if (!task) return;
      this.activeCounts.asr += 1;
      void this.executeAsrTask(task)
        .catch((err) => logger.error(`[AiDetect] 任务执行异常：${err instanceof Error ? err.message : err}`))
        .finally(() => {
          this.activeCounts.asr -= 1;
        });
    }
  }

  /** 按队列取进度写入口（三条队列只有落库表不同） */
  private progressWriter(kind: AiDetectQueueKind): AiDetectProgressWriter {
    return this.repositories[kind];
  }

  /** 首次由调用方按 pollIntervalMs 驱动，故续期也放在这里 */
  private async electAndRenew(): Promise<void> {
    const { leaseTtlMs } = aiDetectConfig.scheduler;

    if (!this.lease) {
      this.lease = await tryAcquireLeaderLease({ key: aiDetectConfig.scheduler.leaderKey, ttlMs: leaseTtlMs });
      if (this.lease) {
        this.renewFailures = 0;
        this.lastRenewAt = Date.now();
        logger.info(`[AiDetect] 获得 leader 租约（worker=${getWorkerId()}）`);
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
      logger.warn(`[AiDetect] 租约续期失败（第 ${this.renewFailures} 次），下次重试`);
      return;
    }

    logger.error('[AiDetect] 连续续期失败，让出 leader');
    await this.lease.release();
    this.lease = null;
    this.renewFailures = 0;
  }

  /**
   * 卡死任务恢复（仅 leader 调用），三条队列各恢复一遍。
   *
   * ① 接手租约时立刻清扫**任何 workerId** 的 running 孤儿（此刻本进程没有在途任务，
   *    Mongo 里的 running 行必然是上一代进程遗留）。
   * ② 周期性按 updatedAt 阈值处理跨进程孤儿（阈值须大于一次完整的检测/抽帧/转写耗时）。
   *
   * 以「重新入队」为主：中断多发生在进程重启/发布期间，直接判失败会让已跑大半的任务白费。
   * 只有 attempts 达到 TASK_MAX_ATTEMPTS 的才标记失败。
   */
  private async recoverStuckTasks(): Promise<void> {
    // 任一队列有在途任务就不做任何"恢复"，避免误伤自己
    if (this.totalActive > 0) return;
    const interval = Math.max(60_000, Math.floor(aiDetectConfig.scheduler.taskStaleMs / 2));
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();

    const staleBefore = new Date(Date.now() - aiDetectConfig.scheduler.taskStaleMs);

    await this.recoverQueue('scene', staleBefore);
    await this.recoverQueue('frames', staleBefore);
    await this.recoverQueue('asr', staleBefore);
  }

  /** 单条队列的恢复四件套（三个仓储方法同形，只有落库表不同） */
  private async recoverQueue(kind: AiDetectQueueKind, staleBefore: Date): Promise<void> {
    const repo = this.repositories[kind];
    const label = kind === 'frames' ? '抽帧' : kind === 'asr' ? '转写' : '切分';

    const requeued = await repo.requeueOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeued > 0) {
      logger.warn(`[AiDetect] 恢复：${requeued} 条中断的${label}任务已重新入队（含其他 worker 遗留）`);
    }
    const exhausted = await repo.failExhaustedOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhausted > 0) {
      logger.warn(`[AiDetect] 恢复：${exhausted} 条达重试上限的${label}任务已标记失败`);
    }

    const requeuedStale = await repo.requeueStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeuedStale > 0) {
      logger.warn(`[AiDetect] 恢复：${requeuedStale} 条超时未更新的${label}任务已重新入队`);
    }
    const exhaustedStale = await repo.failExhaustedStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhaustedStale > 0) {
      logger.warn(`[AiDetect] 恢复：${exhaustedStale} 条超时且达重试上限的${label}任务已标记失败`);
    }
  }

  /** 执行一条已领取的场景切分任务；任何异常都落到 markFailed，不向上抛 */
  private async executeScene(task: AiDetectTaskDocument): Promise<void> {
    const taskId = String(task._id);

    try {
      await this.runScene(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AiDetect] 切分失败 task=${taskId}：${message}`);
      await aiDetectTaskRepository
        .markFailed(taskId, message, new Date())
        .catch((markErr) => logger.error(`[AiDetect] 标记失败态也失败了 task=${taskId}：${markErr}`));
    }
  }

  /** 执行一条已领取的抽帧任务；任何异常都落到 markFailed，不向上抛 */
  private async executeFrameTask(task: AiDetectFrameTaskDocument): Promise<void> {
    const taskId = String(task._id);

    try {
      await this.runFrames(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AiDetect] 抽帧失败 task=${taskId}：${message}`);
      await aiDetectFrameTaskRepository
        .markFailed(taskId, message, new Date())
        .catch((markErr) => logger.error(`[AiDetect] 标记失败态也失败了 task=${taskId}：${markErr}`));
    } finally {
      // 进度节流的条目随任务收尾释放（成功/失败都要删，否则这张表会随任务数无界增长）
      this.lastExtractProgressAt.delete(taskId);
    }
  }

  /** 执行一条已领取的转写任务；任何异常都落到 markFailed，不向上抛 */
  private async executeAsrTask(task: AiDetectAsrTaskDocument): Promise<void> {
    const taskId = String(task._id);

    try {
      await this.runAsr(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AiDetect] 转写失败 task=${taskId}：${message}`);
      await aiDetectAsrTaskRepository
        .markFailed(taskId, message, new Date())
        .catch((markErr) => logger.error(`[AiDetect] 标记失败态也失败了 task=${taskId}：${markErr}`));
    }
  }

  /** 场景切分：解析源视频 → PySceneDetect 检测 →（可选）首尾黑帧检测 → 落场景时间段 */
  private async runScene(task: AiDetectTaskDocument): Promise<void> {
    const taskId = String(task._id);

    // ---- ① 解析源视频 ----
    await this.reportProgress('scene', taskId, PROGRESS_RESOLVE, 'resolve_source');
    const sourceFile = await fileService.getById(task.sourceFileId);
    if (!sourceFile) throw new Error('源视频文件记录不存在（可能已被删除），请重新提交');
    const sourceAbs = path.resolve(fileService.getAbsolutePath(sourceFile));
    if (!fs.existsSync(sourceAbs)) throw new Error('源视频文件已丢失，请重新上传');

    // ---- ② PySceneDetect 场景检测（远程 scenedetect HTTP 容器） ----
    await this.reportProgress('scene', taskId, PROGRESS_DETECT, 'detect');
    // 不在这里传 timeoutMs：传了就覆盖掉 SCENEDETECT_TIMEOUT_MS，让这个环境变量在本路径上失效。
    // 缺省由 ScenedetectHttpClient.resolveTimeout 解析（env SCENEDETECT_TIMEOUT_MS > 常量 SCENE_DETECT_TIMEOUT_MS）。
    const result = await detectScenes(sourceAbs, {
      detector: task.detector,
      // 落库的 0 表示「未指定」，交给检测脚本用该算法的推荐值兜底
      ...(task.threshold > 0 ? { threshold: task.threshold } : {}),
      ...(task.minSceneLenSec > 0 ? { minSceneLenSec: task.minSceneLenSec } : {}),
      ...(task.downscale > 0 ? { downscale: task.downscale } : {}),
      ...(task.frameSkip > 0 ? { frameSkip: task.frameSkip } : {}),
    });
    this.setLastProgress('scene', PROGRESS_DETECT, 'detect');

    // ---- ③ 首尾黑帧检测（可选：提交时 blackDetectSec > 0）----
    // 只扫首尾两段窗口（ffmpeg blackdetect），把贴边的黑场另立成独立场景。
    // 必须放在检测之后：尾窗口的起点要靠 durationMs，而它正是检测结果给的。
    // 检测不到黑场就说明这段视频没有片头/片尾黑场 —— 场景划分原样保留（不是失败）。
    let scenes = result.scenes;
    let blackRanges: IAiDetectBlackSceneMark[] = [];
    if (task.blackDetectSec > 0) {
      await this.reportProgress('scene', taskId, PROGRESS_BLACK, 'black_detect');
      const detected = await detectBlackFrames(sourceAbs, {
        windowMs: task.blackDetectSec * 1000,
        durationMs: result.durationMs,
        ...aiDetectConfig.black,
      });
      const applied = applyHeadTailBlackScenes(scenes, detected, result.durationMs);
      scenes = applied.scenes;
      blackRanges = applied.marks;
      this.setLastProgress('scene', PROGRESS_BLACK, 'black_detect');
    }

    // ---- ④ 落结果 ----
    await this.reportProgress('scene', taskId, PROGRESS_PERSIST, 'persist');
    await aiDetectTaskRepository.markSuccess(taskId, {
      scenes,
      sceneCount: scenes.length,
      durationMs: result.durationMs,
      frameRate: result.frameRate,
      pySceneDetectVersion: result.version,
      blackRanges,
      finishedAt: new Date(),
    });
    logger.info(
      `[AiDetect] 切分完成 task=${taskId} 场景=${scenes.length} 时长=${result.durationMs}ms` +
        (task.blackDetectSec > 0 ? ` 黑场=${blackRanges.length}` : ''),
    );
  }

  /**
   * 场景抽帧：逐场景抽 开始/中间/结束 三帧（ffmpeg），逐帧登记 file 表。
   *
   * 分两段执行，为的是让这个动辄产出上千个文件的任务满足「要么完整、要么零副作用」：
   * ① 抽帧段：所有帧先只落盘、不进 file 表 —— 失败时把已落盘的图片删掉即可回到原状；
   * ② 登记段：全部抽完才开始登记 —— 中途失败则把已登记的记录假删除并删掉磁盘文件。
   * 若边抽边登记，一个在中途失败的抽帧任务会在 file 表里留下一批没人引用、也说不清归属的图片。
   *
   * 已知局限：进程被强杀（不是抛异常）时捕获不到回滚 —— 抽帧段会残留一批没进过 file 表的磁盘图片，
   * 登记段还会额外残留已登记的帧记录。此时任务被中断恢复重新入队并重跑（产出的是另一批新文件，
   * 路径是新建的 UUID），旧的那批无人引用。要彻底消除得引入事务，代价与收益不成比例，故按现状接受。
   * 重跑本身是安全的：成功时 markSuccess 整体覆盖 frameScenes，不会把两次的结果叠在一起。
   */
  private async runFrames(task: AiDetectFrameTaskDocument): Promise<void> {
    const taskId = String(task._id);

    // ---- ① 解析来源场景任务与源视频 ----
    await this.reportProgress('frames', taskId, PROGRESS_RESOLVE, 'resolve_source');
    const sceneTask = await aiDetectTaskRepository.findById(task.sourceTaskId);
    if (!sceneTask) throw new Error('来源场景切分任务不存在（可能已被删除），请重新提交');
    if (sceneTask.status !== 'success' || sceneTask.scenes.length === 0) {
      throw new Error('来源场景切分任务已不是完成态，请重新提交');
    }
    const sourceFile = await fileService.getById(task.sourceFileId);
    if (!sourceFile) throw new Error('源视频文件记录不存在（可能已被删除），请重新提交');
    const sourceAbs = path.resolve(fileService.getAbsolutePath(sourceFile));
    if (!fs.existsSync(sourceAbs)) throw new Error('源视频文件已丢失，请重新上传');

    const scenes = sceneTask.scenes;
    const sourceStem = resolveSourceStem(task.originalName || sourceFile.originalName);
    /** 本次任务的落盘清单：抽帧段结束后就是登记段的输入，失败时是回滚的依据 */
    const pending: PendingFrame[] = [];
    /** 每个场景的帧与其区间，登记段据此拼 frameScenes */
    const plans: { index: number; startMs: number; endMs: number; frames: PendingFrame[] }[] = [];

    try {
      // ---- ② 逐场景抽帧 ----
      // 单条任务**内部**顺序执行（一次一个 ffmpeg 子进程）：并行抽只会互相抢解码与磁盘，
      // 吞吐由队列层的 AI_DETECT_FRAME_CONCURRENCY（能同时跑几条抽帧任务）来调，而不是在任务内并发。
      await this.reportProgress('frames', taskId, PROGRESS_EXTRACT, 'extract');

      let done = 0;
      for (const scene of scenes) {
        const frames: PendingFrame[] = [];

        for (const { kind, timeMs } of resolveSceneFrameTimes(scene, task.frameRate)) {
          const frame: PendingFrame = {
            abs: nextUploadPath(fileConfig.uploadDir, FRAME_EXT),
            fileName: resolveFrameFileName(sourceStem, scene.index, kind),
            kind,
            timeMs,
            fileId: '',
          };
          // 先入清单再抽帧：ffmpeg 失败时可能已经写出了半张图，只有提前入列才能被回滚清掉
          pending.push(frame);

          await extractFrame(sourceAbs, {
            atMs: timeMs,
            destAbs: frame.abs,
            quality: aiDetectConfig.frames.jpegQuality,
            timeoutMs: aiDetectConfig.frames.extractTimeoutMs,
          });
          frames.push(frame);
        }

        plans.push({
          index: scene.index,
          startMs: scene.startMs,
          endMs: scene.endMs,
          frames,
        });
        done += 1;
        await this.reportExtractProgress(taskId, done, scenes.length);
      }

      // ---- ③ 全部抽完才登记 file 表 ----
      await this.reportProgress('frames', taskId, PROGRESS_PERSIST, 'persist');
      const frameScenes: IAiDetectSceneFrames[] = [];
      let frameCount = 0;

      for (const plan of plans) {
        const frames: IAiDetectFrame[] = [];
        for (const frame of plan.frames) {
          const { created } = await fileService.upload(
            buildMulterFile(frame.abs, frame.fileName, AI_DETECT_FRAME_MIME),
            {
              category: AI_DETECT_FRAME_CATEGORY,
              ...(task.userId ? { createBy: task.userId } : {}),
              // 帧与场景任务的对应关系落进 metadata：以后要按「哪个场景的哪一帧」反查时不必翻任务文档
              metadata: {
                sourceTaskId: task.sourceTaskId,
                sceneIndex: plan.index,
                frameKind: frame.kind,
                timeMs: frame.timeMs,
              },
            },
          );

          const fileId = String(created._id);
          frame.fileId = fileId;
          frames.push({
            kind: frame.kind,
            timeMs: frame.timeMs,
            fileId,
            url: `/api/files/${fileId}/download`,
          });
        }

        frameScenes.push({
          index: plan.index,
          startMs: plan.startMs,
          endMs: plan.endMs,
          frames,
        });
        frameCount += frames.length;
      }

      await aiDetectFrameTaskRepository.markSuccess(taskId, {
        frameScenes,
        frameCount,
        finishedAt: new Date(),
      });
      logger.info(
        `[AiDetect] 抽帧完成 task=${taskId} 场景=${scenes.length} 帧=${frameCount}`,
      );
    } catch (err) {
      await this.rollbackFrames(pending);
      throw err;
    }
  }

  /**
   * 抽帧失败时的回滚：把本次任务已产出的帧收拾干净。
   *
   * - 已登记进 file 表的：按项目规范假删除（flag 置 0，不物理删记录），同时删掉磁盘文件 ——
   *   任务已失败，这批图没有任何对外引用（下载接口查不到 flag=0 的记录），留着只是占盘。
   * - 还没登记的（抽帧阶段就失败）：直接删磁盘文件，它们从没进过库。
   *
   * 回滚自身出错只记日志、不再抛：真正要展示给用户的是抽帧失败的原因（由 execute 的兜底写库）。
   */
  private async rollbackFrames(pending: PendingFrame[]): Promise<void> {
    for (const frame of pending) {
      if (frame.fileId) {
        await fileService
          .delete(frame.fileId)
          .catch((err) =>
            logger.warn(
              `[AiDetect] 抽帧回滚：假删除帧记录失败 fileId=${frame.fileId}：${err instanceof Error ? err.message : err}`,
            ),
          );
      }
      removeFileQuietly(frame.abs, (message) =>
        logger.warn(`[AiDetect] 抽帧回滚：删除帧文件失败 ${frame.abs}：${message}`),
      );
    }
  }

  /**
   * 抽帧进度（真实百分比）：每完成一个场景推进一格，但按 progressMinIntervalMs 节流写库。
   *
   * 场景数上百时逐个写库就是上百次 update，节流阈值取配置里已有的那项（场景检测因为只有四档
   * 粗粒度而没用上它）。节流按 taskId 分别记，故多条抽帧任务并发时互不压制。
   * 不需要为「最后一次进度」补写：成功时 markSuccess 直接把进度置 1。
   */
  private async reportExtractProgress(
    taskId: string,
    done: number,
    total: number,
  ): Promise<void> {
    const progress = PROGRESS_EXTRACT + (PROGRESS_EXTRACT_END - PROGRESS_EXTRACT) * (done / total);
    this.setLastProgress('frames', progress, 'extract');

    const lastWriteAt = this.lastExtractProgressAt.get(taskId) ?? 0;
    if (Date.now() - lastWriteAt < aiDetectConfig.scheduler.progressMinIntervalMs) {
      return;
    }
    this.lastExtractProgressAt.set(taskId, Date.now());
    await this.reportProgress('frames', taskId, progress, 'extract');
  }

  /**
   * 场景转写：按固定时长切块抽音频 → 逐块走 subtitle 模块的 Whisper 链路 → 把文本段按场景归并。
   *
   * 为什么按块：subtitle 链路对音频卡 `ASR_MAX_AUDIO_BYTES`（50MB），而 16k 单声道 wav 每秒 32KB
   * ⇒ 约 26 分钟就到顶，长片必须切。短片只会规划出 1 块，等价于「整片转写一次」。
   *
   * 为什么每块都要登记 file 表：`subtitleTaskService.submit` 只接受 fileId（不接受裸路径），
   * 所以块音频必须进 files 集合 —— 它们同时是可回溯的中间产物（metadata 里记着来自哪个任务的哪一段）。
   *
   * 与抽帧同样的两段式取舍：块音频先落盘、登记、提子任务，任一步失败即回滚已产出的块
   * （已登记的假删除 + 删磁盘，未登记的只删磁盘），保证「要么完整、要么零副作用」。
   *
   * 已知局限：进程被强杀时捕获不到回滚，会残留部分已登记的块音频；任务被中断恢复重跑后会重新
   * 提全部块（不传 client_job_id，故 whisper 侧也不去重）。要彻底消除得引入事务，代价与收益不成比例。
   */
  private async runAsr(task: AiDetectAsrTaskDocument): Promise<void> {
    const taskId = String(task._id);

    // ---- ① 解析来源场景任务与源视频 ----
    await this.reportProgress('asr', taskId, PROGRESS_RESOLVE, 'resolve_source');
    const sceneTask = await aiDetectTaskRepository.findById(task.sourceTaskId);
    if (!sceneTask) throw new Error('来源场景切分任务不存在（可能已被删除），请重新提交');
    if (sceneTask.status !== 'success' || sceneTask.scenes.length === 0) {
      throw new Error('来源场景切分任务已不是完成态，请重新提交');
    }
    const sourceFile = await fileService.getById(task.sourceFileId);
    if (!sourceFile) throw new Error('源视频文件记录不存在（可能已被删除），请重新提交');
    const sourceAbs = path.resolve(fileService.getAbsolutePath(sourceFile));
    if (!fs.existsSync(sourceAbs)) throw new Error('源视频文件已丢失，请重新上传');

    // 时长优先取来源场景任务记录的（PySceneDetect 探测过），为 0 时现场用 ffprobe 兜底
    const durationMs =
      task.durationMs > 0 ? task.durationMs : await probeDurationMs(sourceAbs).catch(() => 0);
    if (durationMs <= 0) throw new Error('无法确定源视频时长，无法规划转写切块');

    const chunks = planAsrChunks(durationMs, aiDetectConfig.asr.chunkMs);
    const sourceStem = resolveSourceStem(task.originalName || sourceFile.originalName);
    /** 本次任务的块产物：失败时按它回滚 */
    const produced: ProducedAudioChunk[] = [];
    const allSegments: IAiDetectAsrSegment[] = [];
    let provider = '';

    try {
      // ---- ② 逐块转写（真实百分比：每块推进一格，块内等待透传子任务进度） ----
      await this.reportProgress('asr', taskId, PROGRESS_ASR, 'asr', `共 ${chunks.length} 块待转写`);

      for (const chunk of chunks) {
        const label = `第 ${chunk.index}/${chunks.length} 块`;

        const chunkAbs = nextUploadPath(fileConfig.uploadDir, AUDIO_EXT);
        const entry: ProducedAudioChunk = { abs: chunkAbs, fileId: '' };
        // 先入清单再抽：ffmpeg 失败时可能已经写出半成品，只有提前入列才能被回滚清掉
        produced.push(entry);

        await this.reportProgress(
          'asr',
          taskId,
          this.asrProgress(chunk.index - 1, chunks.length),
          'asr',
          `提取${label}音频`,
        );
        await extractAudioClip(sourceAbs, chunkAbs, {
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          timeoutMs: aiDetectConfig.asr.extractTimeoutMs,
        });

        // 登记进 file 表（转写链路只认 fileId）
        const { created } = await fileService.upload(
          buildMulterFile(
            chunkAbs,
            resolveChunkFileName(sourceStem, chunk.index),
            AI_DETECT_ASR_AUDIO_MIME,
          ),
          {
            category: AI_DETECT_ASR_AUDIO_CATEGORY,
            ...(task.userId ? { createBy: task.userId } : {}),
            metadata: {
              asrTaskId: taskId,
              sourceTaskId: task.sourceTaskId,
              chunkIndex: chunk.index,
              startMs: chunk.startMs,
              endMs: chunk.endMs,
            },
          },
        );
        const wavFileId = String(created._id);
        entry.fileId = wavFileId;

        // 提交给 subtitle 模块（它自己的 leader 调度器与 SUBTITLE_CONCURRENCY 闸门决定何时跑）
        const submitted = await subtitleTaskService.submit({
          fileId: wavFileId,
          sourceType: 'fileId',
          ...(task.userId ? { userId: task.userId } : {}),
        });
        if ('error' in submitted) {
          throw new Error(`提交${label}转写失败：${submitted.error}`);
        }
        const subtitleTaskId = submitted.data.taskId;

        const child = await this.waitForSubtitle(taskId, subtitleTaskId, chunk.index, chunks.length);
        provider = child.provider || provider;

        // SRT 落在本机 uploads（cluster 共享磁盘），直接读盘解析，不必走 HTTP
        const cues = await this.readSubtitleCues(child.srtFileId);
        allSegments.push(...offsetCues(cues, chunk.startMs));

        // 块记录立刻落库：中途失败时它是「失败在哪一块」的唯一线索
        await aiDetectAsrTaskRepository.pushChunk(taskId, {
          index: chunk.index,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          wavFileId,
          wavUrl: `/api/files/${wavFileId}/download`,
          subtitleTaskId,
          cueCount: cues.length,
        });

        await this.reportProgress(
          'asr',
          taskId,
          this.asrProgress(chunk.index, chunks.length),
          'asr',
          `已完成 ${label}`,
        );
      }

      // ---- ③ 归并：全局文本段 + 按场景归组 ----
      await this.reportProgress('asr', taskId, PROGRESS_PERSIST, 'persist');
      const segments = [...allSegments].sort((a, b) => a.startMs - b.startMs);
      const sceneSegments = groupCuesByScene(sceneTask.scenes, segments);

      await aiDetectAsrTaskRepository.markSuccess(taskId, {
        segments,
        sceneSegments,
        segmentCount: segments.length,
        provider,
        finishedAt: new Date(),
      });
      logger.info(
        `[AiDetect] 转写完成 task=${taskId} 块=${chunks.length} 文本段=${segments.length} 通道=${provider || '未知'}`,
      );
    } catch (err) {
      await this.rollbackAsrChunks(produced);
      throw err;
    }
  }

  /** 转写进度：按已完成的块数在 [PROGRESS_ASR, PROGRESS_ASR_END] 之间线性插值 */
  private asrProgress(done: number, total: number): number {
    if (total <= 0) return PROGRESS_ASR;
    return PROGRESS_ASR + (PROGRESS_ASR_END - PROGRESS_ASR) * (done / total);
  }

  /**
   * 轮询等待一块转写的字幕子任务完成（口径同 videoPipelineV2 / digitalHuman 的 waitForSubtitle）。
   *
   * - 子任务的 `message` 会透传进本任务：长块转写期间提示必须一直在动，否则看起来像卡死。
   * - 超时上限 `AI_DETECT_ASR_SUBTITLE_TIMEOUT_MS` 必须 ≥ SUBTITLE_TASK_STALE_MS，
   *   否则合法的长块会被本侧提前判超时。
   */
  private async waitForSubtitle(
    parentTaskId: string,
    subtitleTaskId: string,
    chunkIndex: number,
    chunkTotal: number,
  ): Promise<{ srtFileId: string; provider: string }> {
    const deadline = Date.now() + aiDetectConfig.asr.subtitleTimeoutMs;
    const label = `第 ${chunkIndex}/${chunkTotal} 块`;
    let lastWriteAt = 0;

    while (Date.now() < deadline) {
      const doc = await subtitleTaskRepository.findById(subtitleTaskId);
      if (!doc) throw new Error('字幕子任务不存在（可能已被清理），请重新提交');

      if (doc.status === 'success') {
        if (!doc.srtFileId) throw new Error(`${label}转写已完成但未产出字幕，请重新提交`);
        return { srtFileId: doc.srtFileId, provider: doc.provider ?? '' };
      }
      if (doc.status === 'failed' || doc.status === 'cancelled') {
        throw new Error(`${label}转写失败：${doc.message || '未知原因'}`);
      }

      const now = Date.now();
      if (now - lastWriteAt >= aiDetectConfig.scheduler.progressMinIntervalMs) {
        lastWriteAt = now;
        const detail = doc.message || aiDetectStageLabel(doc.stage);
        await this.reportProgress(
          'asr',
          parentTaskId,
          this.asrProgress(chunkIndex - 1, chunkTotal),
          'asr',
          `${label}转写中 · ${detail}`,
        );
      }
      await sleep(aiDetectConfig.scheduler.pollIntervalMs);
    }

    const minutes = Math.round(aiDetectConfig.asr.subtitleTimeoutMs / 60_000);
    throw new Error(`${label}转写超时（超过 ${minutes} 分钟），请缩短视频或稍后重试`);
  }

  /** 读字幕子任务产出的 SRT 并解析成分段（毫秒） */
  private async readSubtitleCues(srtFileId: string): Promise<SrtCue[]> {
    const srtFile = await fileService.getById(srtFileId);
    if (!srtFile) throw new Error('字幕文件记录不存在（可能已被清理），请重新提交');

    const srtAbs = path.resolve(fileService.getAbsolutePath(srtFile));
    if (!fs.existsSync(srtAbs)) throw new Error('字幕文件已丢失，请重新提交');

    return parseSrt(fs.readFileSync(srtAbs, 'utf8'));
  }

  /**
   * 转写失败时的回滚：把本次任务已产出的块音频收拾干净（口径同抽帧）。
   *
   * - 已登记进 file 表的：假删除（flag 置 0，不物理删记录）+ 删磁盘文件 —— 任务已失败，
   *   这批音频没有对外引用，留着只是占盘。
   * - 未登记的（提取阶段就失败）：只删磁盘文件。
   *
   * 回滚自身出错只记日志、不再抛：要展示给用户的是转写失败的原因（由 executeAsrTask 兜底写库）。
   */
  private async rollbackAsrChunks(produced: ProducedAudioChunk[]): Promise<void> {
    for (const item of produced) {
      if (item.fileId) {
        await fileService
          .delete(item.fileId)
          .catch((err) =>
            logger.warn(
              `[AiDetect] 转写回滚：假删除音频块记录失败 fileId=${item.fileId}：${err instanceof Error ? err.message : err}`,
            ),
          );
      }
      removeFileQuietly(item.abs, (message) =>
        logger.warn(`[AiDetect] 转写回滚：删除音频块失败 ${item.abs}：${message}`),
      );
    }
  }

  /** 更新指定队列的进度快照（各自的 /engine/status 展示用） */
  private setLastProgress(kind: AiDetectQueueKind, pct: number, stage: string): void {
    this.lastProgress[kind] = { pct, stage };
  }

  /**
   * 写一次进度（按队列落到各自的表）。
   *
   * `message` 不传时用阶段的中文标签；转写这类「同一阶段内还要说明在第几块」的场景
   * 可以传自定义文案（子任务进度透传也走这里）。
   */
  private async reportProgress(
    kind: AiDetectQueueKind,
    taskId: string,
    progress: number,
    stage: string,
    message?: string,
  ): Promise<void> {
    this.setLastProgress(kind, progress, stage);
    const text = message ?? aiDetectStageLabel(stage);
    // 隔离 ALS：避免把某个请求用户的 id 写进 updateBy（见 start() 的说明）
    await runIsolatedContext(() =>
      this.progressWriter(kind)
        .updateProgress(taskId, { progress, stage, message: text })
        .catch(() => {
          // 进度上报失败不影响检测/抽帧/转写本身
        }),
    );
  }
}

export const aiDetectDispatcher = new AiDetectDispatcher();

// 关机钩子：与字幕/IndexTTS/数字人同样的排空语义
registerShutdownHook(() => aiDetectDispatcher.stop());
