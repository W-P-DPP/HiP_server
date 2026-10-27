import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Logger } from '../../utils/Logger.ts';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { registerShutdownHook } from '../../utils/shutdownHooks.ts';
import { SHUTDOWN_TIMEOUT_MS, TASK_MAX_ATTEMPTS } from '../../utils/constant/ClusterConstants.ts';
import { indexttsStageLabel } from '../../utils/constant/indextts.ts';
import { VOICE_TRAIN_V2_PREVIEW_CATEGORY } from '../../utils/constant/voiceTrainV2.ts';
import { probeDurationSec } from '../../utils/videoHelper/probe.ts';
import { runIsolatedContext } from '../../utils/requestContext.ts';
import indexttsConfig from '../../utils/indextts/indextts.config.ts';
import { getIndexttsEngine } from '../../utils/indextts/indexttsEngineFactory.ts';
import type { IndexttsProgress } from '../../utils/indextts/IndexttsWorker.ts';
import {
  tryAcquireLeaderLease,
  type IndexttsLeaderLease,
} from '../../utils/indextts/IndexttsLeaderLease.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import { voiceTrainV2VoiceService } from './voiceTrainV2Voice.service.ts';
import { voiceTrainV2SynthesisTaskRepository } from './voiceTrainV2SynthesisTask.repository.ts';
import { buildMulterFile, nextUploadPath, removeFileQuietly, sanitizeFileName } from './voiceTrainV2Upload.helper.ts';
import type { VoiceTrainV2SynthesisTaskDocument } from './voiceTrainV2SynthesisTask.entity.ts';

const logger = Logger.getInstance();

/** 连续续期失败几次才判定失去 leader 地位（容忍一次 Redis 抖动） */
const MAX_RENEW_FAILURES = 2;

/**
 * IndexTTS 合成任务调度器。
 *
 * 为什么还需要「leader」：本服务跑在 node:cluster 下（生产 CLUSTER_WORKERS=10）。
 * 若 10 个 worker 各跑一个调度循环，就会同时抢 Mongo 队列、各写进度、各做全表恢复扫描。
 * 因此用 Redis 租约把「跑调度循环」收敛到唯一一个进程。
 *
 * 注意租约的语义在 `INDEXTTS_MODE=remote` 下已经变了：过去它守护的是「全机唯一的热模型」
 * （模型在 Node 子进程里，多个就会撑爆显存）；现在模型由独立的 GPU 服务容器持有，
 * 租约只负责选出唯一调度者。它依然是必需的，但不再是防 OOM 的那道闸。
 *
 * 队列本身就是 Mongo 里 status=pending 的任务集合，**刻意不再引入 AsyncQueue / 信号量**：
 * 租约已保证单调度器，调度器又是单飞的。请不要"顺手"再加一层并发控制。
 */
class IndexttsDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private lease: IndexttsLeaderLease | null = null;
  private renewFailures = 0;
  private lastRenewAt = 0;
  /** 单飞标志：一个任务执行期间不再领取下一个 */
  private busy = false;
  private running = false;
  /** 上次卡死任务清理时间（leader 专属，按 taskStaleMs/2 节流） */
  private lastRecoveryAt = 0;

  /** 懒启动（幂等）。首次提交合成任务时调用，保证没 GPU 的开发机不会去加载模型 */
  start(): void {
    if (this.running) return;
    if (!indexttsConfig.enabled) return;
    this.running = true;
    logger.info(`[Indextts] dispatcher 启动（worker=${getWorkerId()}）`);
    // 调度循环由 HTTP 请求触发，若不隔离，setTimeout 链会继承发起请求的 ALS 上下文，
    // 之后所有写库（claimNextPending / updateProgress / markSuccess）的 updateBy、
    // 以及新文档的 createBy 都会被填成那个用户的 id。与 materialLibrary 同法隔离。
    runIsolatedContext(() => {
      void this.tick();
    });
  }

  isLeader(): boolean {
    return this.lease !== null;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** 优雅关闭：停掉循环 → 等在途任务结算 → 关掉 Python worker → 释放租约 */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.busy) {
      // SHUTDOWN_TIMEOUT_MS 装不下一个长合成任务，等不到就放弃 —— 由下一代的
      // 中断恢复流程把它重新入队（attempts 达上限才判失败）
      const deadline = Date.now() + Math.max(0, SHUTDOWN_TIMEOUT_MS - 1000);
      logger.info('[Indextts] 等待在途合成任务结算…');
      while (this.busy && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // remote 模式下 shutdown 是空操作：GPU 服务为开发/生产共用，Node 无权关停它
    await getIndexttsEngine(indexttsConfig).shutdown();
    if (this.lease) {
      await this.lease.release();
      this.lease = null;
    }
    logger.info('[Indextts] dispatcher 已停止');
  }

  /** 调度循环：选举/续期 → 领取一条 pending 任务 → 执行 */
  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.electAndRenew();
      if (this.lease) await this.recoverStuckTasks();
      // 就绪闸门：远端 GPU 服务不可达（典型场景是容器正在重启）时不领取任务，
      // 让它们留在 pending，等容器恢复后自动继续 —— 好过领出来立刻烧成 failed。
      // 本地模式下恒为 true，因此不会挡住「首个任务触发懒加载」。
      const engine = getIndexttsEngine(indexttsConfig);
      if (this.lease && !this.busy && (await engine.canAcceptWork())) {
        const task = await voiceTrainV2SynthesisTaskRepository.claimNextPending(getWorkerId());
        if (task) {
          this.busy = true;
          // execute 自身不抛（异常都落到 markFailed），但 finally 派生出的 promise
          // 仍需兜底 catch —— 否则任何逸出异常都会变成 unhandledRejection 杀掉 worker
          void this.execute(task)
            .catch(err => logger.error(`[Indextts] 任务执行异常：${err instanceof Error ? err.message : err}`))
            .finally(() => {
              this.busy = false;
            });
        }
      }
    } catch (err) {
      // 单次 tick 失败不应终止循环（Redis 抖动、Mongo 瞬时不可用等）
      logger.error(`[Indextts] 调度循环异常：${err instanceof Error ? err.message : err}`);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), indexttsConfig.pollIntervalMs);
    this.timer.unref();
  }

  /** 首次经调用方按 pollIntervalMs 驱动，故续期也放在这里，无需另起定时器 */
  private async electAndRenew(): Promise<void> {
    const { leaseTtlMs } = indexttsConfig;

    if (!this.lease) {
      this.lease = await tryAcquireLeaderLease({ ttlMs: leaseTtlMs });
      if (this.lease) {
        this.renewFailures = 0;
        this.lastRenewAt = Date.now();
        logger.info(`[Indextts] 获得 leader 租约（worker=${getWorkerId()}）`);
        this.prewarmIfEnabled();
      }
      return;
    }

    // 续期周期取 TTL 的一半，留足一次重试余量
    if (Date.now() - this.lastRenewAt < leaseTtlMs / 2) return;
    this.lastRenewAt = Date.now();

    const ok = await this.lease.renew();
    if (ok) {
      this.renewFailures = 0;
      return;
    }

    this.renewFailures += 1;
    if (this.renewFailures < MAX_RENEW_FAILURES) {
      logger.warn(`[Indextts] 租约续期失败（第 ${this.renewFailures} 次），下次重试`);
      return;
    }

    // 连续失败：判定失权。本地模式下必须先停掉 Python worker —— 否则在旧租约到期、
    // 新 leader 拉起自己的模型之前，本进程的模型仍占着显存，两个热模型会把卡打爆。
    // remote 模式下 shutdown 是刻意的空操作：模型在共用的 GPU 容器里，
    // 任何一个 Node 让出 leader 都不该把它关掉。
    logger.error('[Indextts] 连续续期失败，让出 leader');
    await getIndexttsEngine(indexttsConfig).shutdown();
    await this.lease.release();
    this.lease = null;
    this.renewFailures = 0;
  }

  /**
   * 预热：只在成为 leader 且开启 INDEXTTS_AUTOSTART 时触发。
   *
   * 必须放在「拿到租约之后」而不是进程启动时 —— 否则每个 cluster worker 都会去
   * 加载一份模型 / 打一遍远端，正好是租约要防的事。
   *
   * remote 模式下它退化为「确认远端服务就绪」（顺带触发一次幂等 warmup），
   * 没有本地副作用；本地模式下仍是那 1–3 分钟的模型加载。两者都不阻塞调度循环。
   */
  private prewarmIfEnabled(): void {
    if (!indexttsConfig.autostart) return;
    // workerEnabled 是 local 模式的概念（常驻 worker vs 一次性子进程），remote 下不适用
    if (indexttsConfig.mode === 'local' && !indexttsConfig.workerEnabled) return;
    const engine = getIndexttsEngine(indexttsConfig);
    if (engine.isReady() || engine.isUnhealthy()) return;
    const target =
      engine.kind === 'remote'
        ? `远端推理服务 ${indexttsConfig.baseUrl}`
        : '模型（首次加载约 1–3 分钟）';
    logger.info(`[Indextts] 预热：确认${target}就绪…`);
    void engine
      .ensureReady()
      .then(() => logger.info('[Indextts] 预热完成，引擎已就绪'))
      .catch(err => logger.warn(`[Indextts] 预热失败（首个任务将重试）：${err instanceof Error ? err.message : err}`));
  }

  /**
   * 卡死任务恢复（仅 leader 调用）。
   *
   * 两条互补的恢复路径：
   * ① 接手租约时立刻处理**任何 workerId** 的 running 任务。依据是「租约保证全机只有一个
   *    调度器，且调度器单飞」—— 因此此刻 Mongo 里任何 running 行都必然不在执行中，是上一代
   *    进程遗留的孤儿。不能只匹配本 workerId：cluster 重启后 worker id 会重新从 1 分配，
   *    旧进程写的 id 未必等于新 leader 的 id，那样孤儿只能干等到陈旧阈值（默认 90 分钟）。
   * ② 周期性按 updatedAt 阈值处理跨进程孤儿（阈值必须大于「冷启动 + 单任务」，
   *    默认 90 分钟；否则会把正在加载模型的合法任务误判为孤儿）。这是兜底路径。
   *
   * 两条路径都以「重新入队」为主：远端作业以 clientJobId(= taskId) 幂等，重投会命中同一
   * 作业 —— 已完成的直接下产物，仍在跑的续等。只有 attempts 达到 TASK_MAX_ATTEMPTS 的才
   * 标记失败，避免个别任务无限重试。
   *
   * 注意不能像 V1 那样用「每代只跑一次」的 Redis 锁：同一代次内重启的进程会因锁已存在而
   * 完全跳过恢复，导致被中断的任务永远停在 running。
   */
  private async recoverStuckTasks(): Promise<void> {
    if (this.busy) return; // 本进程正在执行任务，不做任何"恢复"，避免误伤自己
    const interval = Math.max(60_000, Math.floor(indexttsConfig.taskStaleMs / 2));
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();

    const requeued = await voiceTrainV2SynthesisTaskRepository.requeueOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeued > 0) {
      logger.warn(`[Indextts] 恢复：${requeued} 条中断任务已重新入队（含其他 worker 遗留）`);
    }
    const exhausted = await voiceTrainV2SynthesisTaskRepository.failExhaustedOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhausted > 0) {
      logger.warn(`[Indextts] 恢复：${exhausted} 条达重试上限的任务已标记失败`);
    }

    const staleBefore = new Date(Date.now() - indexttsConfig.taskStaleMs);
    const requeuedStale = await voiceTrainV2SynthesisTaskRepository.requeueStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeuedStale > 0) logger.warn(`[Indextts] 恢复：${requeuedStale} 条超时未更新的任务已重新入队`);
    const exhaustedStale = await voiceTrainV2SynthesisTaskRepository.failExhaustedStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhaustedStale > 0) {
      logger.warn(`[Indextts] 恢复：${exhaustedStale} 条超时且达重试上限的任务已标记失败`);
    }
  }

  /** 执行一条已领取的任务；任何异常都落到 markFailed，不向上抛 */
  private async execute(task: VoiceTrainV2SynthesisTaskDocument): Promise<void> {
    const taskId = String(task._id);
    const outDir = path.join(indexttsConfig.runtimeDir, 'out');
    const rawOutput = path.join(outDir, `${crypto.randomUUID()}.wav`);
    let lastProgressWriteAt = 0;

    /** 进度写库节流：worker 发 marker 的频率远高于 UI 需要，而所有 worker 都在轮询这个文档 */
    const onProgress = (p: IndexttsProgress): void => {
      const now = Date.now();
      if (now - lastProgressWriteAt < indexttsConfig.progressMinIntervalMs) return;
      lastProgressWriteAt = now;
      const seg = p.segTotal && p.segCur ? ` · 段落 ${p.segCur}/${p.segTotal}` : '';
      // 进度回调由 worker 的 stdout 监听器触发，而该监听器可能是在别的 ALS 上下文里注册的
      // （worker 跨任务复用），故写库前再隔离一次，确保 updateBy 不被填成某个用户
      runIsolatedContext(() => {
        void voiceTrainV2SynthesisTaskRepository
          .updateProgress(taskId, {
            progress: p.pct,
            stage: p.stage,
            message: `${indexttsStageLabel(p.stage)}${seg}`,
          })
          .catch(() => {
            // 进度上报失败不影响合成本身
          });
      });
    };

    try {
      // 放在 try 内：runtimeDir 只读/写满时 mkdir 会抛，落到下面的 markFailed 而不是逸出
      fs.mkdirSync(outDir, { recursive: true });
      await this.reportProgress(taskId, 0, 'config', indexttsStageLabel('config'));

      const resolved = await voiceTrainV2VoiceService.resolveReference(task.voiceId, task.userId);
      if ('error' in resolved) throw new Error(resolved.error);

      // 参考音必须 resolve 成绝对路径：本地 Python worker 会直接按这个路径读文件；
      // remote 模式下由客户端把该文件读成字节上行，路径不跨越容器边界
      logger.info(
        `[Indextts] 开始合成 task=${taskId} voice=${task.voiceId} engine=${indexttsConfig.mode}` +
          `${indexttsConfig.mode === 'remote' ? `@${indexttsConfig.baseUrl}` : ''} ref=${resolved.data.absPath}`,
      );

      const engine = getIndexttsEngine(indexttsConfig);
      const spec = {
        text: task.text,
        output: rawOutput,
        reference: resolved.data.absPath,
        speed: task.speedMode,
        // remote 模式下作为幂等键上行（重试不会重复消耗 GPU），本地仅用于日志关联
        clientJobId: taskId,
      };

      let rawAudio: string;
      if (engine.kind === 'remote') {
        // 远端服务连续失败已熔断：继续投递只会让每条任务都白等一轮超时
        if (engine.isUnhealthy()) {
          throw new Error(
            `IndexTTS 推理服务连续失败已熔断（${indexttsConfig.baseUrl}），请检查容器状态后重试`,
          );
        }
        rawAudio = await engine.run(spec, onProgress);
      } else if (indexttsConfig.workerEnabled && !engine.isUnhealthy()) {
        rawAudio = await engine.run(spec, onProgress);
      } else {
        // worker 关闭或反复崩溃：退回一次性子进程（每次重新加载模型 1–3 分钟）
        logger.warn(`[Indextts] worker 不可用（unhealthy=${engine.isUnhealthy()}），改用一次性子进程`);
        rawAudio = await engine.runOneShot(spec, onProgress);
      }

      const result = await this.persistResult(task, resolved.data.voice.resourceName, rawAudio, taskId);
      logger.info(`[Indextts] 合成完成 task=${taskId} file=${result.fileId} 时长=${result.duration.toFixed(2)}s`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Indextts] 合成失败 task=${taskId}：${message}`);
      await voiceTrainV2SynthesisTaskRepository
        .markFailed(taskId, message, new Date())
        .catch(markErr => logger.error(`[Indextts] 标记失败态也失败了 task=${taskId}：${markErr}`));
    } finally {
      // worker 产物已复制进 uploads；无论成败都清掉 runtime 下的临时 wav
      removeFileQuietly(rawOutput);
    }
  }

  /** 把 worker 产出的 wav 落进 file 表，并标记任务成功 */
  private async persistResult(
    task: VoiceTrainV2SynthesisTaskDocument,
    voiceName: string,
    rawAudio: string,
    taskId: string,
  ): Promise<{ fileId: string; duration: number }> {
    const destAbs = nextUploadPath(fileConfig.uploadDir, '.wav');
    try {
      fs.copyFileSync(rawAudio, destAbs);
      const duration = await probeDurationSec(destAbs);
      const { created } = await fileService.upload(
        buildMulterFile(destAbs, `${sanitizeFileName(voiceName)}-试听.wav`, 'audio/wav'),
        {
          category: VOICE_TRAIN_V2_PREVIEW_CATEGORY,
          ...(task.userId ? { createBy: task.userId } : {}),
          metadata: { taskId, voiceId: task.voiceId, duration },
        },
      );
      const fileId = String(created._id);
      const resultUrl = `/api/files/${fileId}/download`;
      await voiceTrainV2SynthesisTaskRepository.markSuccess(taskId, {
        resultFileId: fileId,
        resultUrl,
        duration,
        finishedAt: new Date(),
      });

      // 只有「试听」任务才回写音色的试听字段。正式合成（purpose=synthesis）绝不回写 ——
      // 否则用户拿这个音色合成一篇文章，列表里原本的试听就被这部长音频覆盖了。
      // 回写本身必须 best-effort：合成已经成功、产物已落盘，任何回写失败都只记日志，
      // 绝不能冒泡到 execute 的 catch —— 那会把成功的合成误标为失败、丢掉产物。
      if (task.purpose === 'preview') {
        try {
          const attached = await voiceTrainV2VoiceService.attachPreview(task.voiceId, {
            previewFileId: fileId,
            previewUrl: resultUrl,
            previewText: task.text,
            previewDuration: duration,
            previewAt: new Date(),
          });
          if (!attached) {
            logger.warn(`[Indextts] 试听回写未生效（音色已删除或已有更新的试听）voice=${task.voiceId} task=${taskId}`);
          }
        } catch (err) {
          logger.warn(`[Indextts] 试听回写失败（不影响合成结果）voice=${task.voiceId} task=${taskId}：${err instanceof Error ? err.message : err}`);
        }
      }

      return { fileId, duration };
    } catch (err) {
      removeFileQuietly(destAbs);
      throw err;
    }
  }

  /** 写一次进度（用于阶段切换这类关键节点，不受节流限制） */
  private async reportProgress(
    taskId: string,
    progress: number,
    stage: string,
    message: string,
  ): Promise<void> {
    // 隔离 ALS：避免把某个请求用户的 id 写进 updateBy（见 start() 的说明）
    await runIsolatedContext(() =>
      voiceTrainV2SynthesisTaskRepository
        .updateProgress(taskId, { progress, stage, message })
        .catch(() => {
          // 进度上报失败不影响合成本身
        }),
    );
  }
}

export const indexttsDispatcher = new IndexttsDispatcher();

// 关机钩子：与 V1 视频队列同样的排空语义
registerShutdownHook(() => indexttsDispatcher.stop());
