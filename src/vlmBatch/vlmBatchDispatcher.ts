import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../../utils/Logger.ts';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { registerShutdownHook } from '../../utils/shutdownHooks.ts';
import { SHUTDOWN_TIMEOUT_MS, TASK_MAX_ATTEMPTS } from '../../utils/constant/ClusterConstants.ts';
import { VLM_BATCH_PROGRESS_START, vlmBatchStageLabel } from '../../utils/constant/vlmBatch.ts';
import vlmConfig from '../../utils/vlm/vlm.config.ts';
import vlmBatchConfig from '../../utils/vlm/vlmBatch.config.ts';
import { getVlmClient } from '../../utils/vlm/VlmHttpClient.ts';
import { normalizeVlmResult } from '../../utils/vlm/validateResult.ts';
import { runIsolatedContext } from '../../utils/requestContext.ts';
import { tryAcquireLeaderLease, type LeaderLease } from '../../utils/leaderLease.ts';
import { fileService } from '../file/file.service.ts';
import { aiDetectFrameTaskRepository } from '../aiDetect/aiDetectFrameTask.repository.ts';
import { batchProgress, flattenFrameItems, resolveBatchStatus } from './vlmBatch.helper.ts';
import { vlmBatchTaskRepository } from './vlmBatchTask.repository.ts';
import type { VlmBatchTaskDocument } from './vlmBatchTask.entity.ts';
import type { CompleteVlmBatchItemData, VlmBatchItemInput } from './vlmBatch.dto.ts';

const logger = Logger.getInstance();

/** 连续续期失败几次才判定失去 leader 地位（容忍一次 Redis 抖动） */
const MAX_RENEW_FAILURES = 2;

/**
 * 批量图像识别调度器。
 *
 * 与 vlmDispatcher / aiDetectDispatcher 同构：Redis 租约把调度循环收敛到唯一进程 —— 否则 10 个
 * worker 会同时扫描队列、同时做全表恢复、同时写给同一批任务进度。
 *
 * 与单图调度器的差别只在执行体：单图任务一张图一次推理，本调度器一次任务**串行**遍历 N 张关键帧，
 * 逐项回写、逐项推进度。两者打的是同一个 Qwen3-VL 容器、同一套客户端配置，只是队列与并发额度分开。
 *
 * 刻意**不以容器 /readyz 为闸门**：容器懒加载 + 空闲卸载，拿它就绪当闸门会「不加载就不领取、
 * 不领取就永不加载」死锁（同 vlmDispatcher 的说明）。
 */
class VlmBatchDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private lease: LeaderLease | null = null;
  private renewFailures = 0;
  private lastRenewAt = 0;
  /** 调度器并发上限（在途批次任务数），来自 VLM_BATCH_CONCURRENCY */
  private readonly maxConcurrent = vlmBatchConfig.scheduler.concurrency;
  /** 当前在途任务数（由 claimAndRun 维护，恒 ≤ maxConcurrent） */
  private active = 0;
  private running = false;
  /** 上次卡死任务清理时间（leader 专属，按 taskStaleMs/2 节流） */
  private lastRecoveryAt = 0;
  /** 最近一次上报的进度（/engine/status 展示用） */
  private lastProgress: { pct: number; stage: string } | null = null;

  /** 懒启动（幂等）。首次提交任务时调用；进程启动时由 clusterWorker 常驻启动 */
  start(): void {
    if (this.running) return;
    if (!vlmBatchConfig.enabled) return;
    this.running = true;
    logger.info(`[VlmBatch] dispatcher 启动（worker=${getWorkerId()}）`);
    // 调度循环由 HTTP 请求触发，若不隔离，setTimeout 链会继承发起请求的 ALS 上下文，
    // 之后所有写库的 updateBy 都会被填成那个用户的 id。
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

  /** 最近一次上报的进度 */
  getLastProgress(): { pct: number; stage: string } | null {
    return this.lastProgress;
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
      // 一次批次含 N 张图串行推理，可能远超 SHUTDOWN_TIMEOUT_MS；超窗由下次启动的中断恢复
      // 流程重新入队，且 execute 会跳过已 success 的项，不重复消耗 GPU。
      const deadline = Date.now() + Math.max(0, SHUTDOWN_TIMEOUT_MS - 1000);
      logger.info('[VlmBatch] 等待在途任务结算…');
      while (this.active > 0 && Date.now() < deadline) {
        await sleep(200);
      }
    }

    if (this.lease) {
      await this.lease.release();
      this.lease = null;
    }
    logger.info('[VlmBatch] dispatcher 已停止');
  }

  /** 调度循环：选举/续期 → 领取 pending 任务 → 执行 */
  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.electAndRenew();
      if (this.lease) await this.recoverStuckTasks();
      if (this.lease) await this.claimAndRun();
    } catch (err) {
      logger.error(`[VlmBatch] 调度循环异常：${err instanceof Error ? err.message : err}`);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), vlmBatchConfig.scheduler.pollIntervalMs);
    this.timer.unref();
  }

  /** 在并发额度内领取并启动任务，直到配额用尽或队列为空（单线程内同步推进，无竞态） */
  private async claimAndRun(): Promise<void> {
    while (this.running && this.active < this.maxConcurrent) {
      const task = await vlmBatchTaskRepository.claimNextPending(getWorkerId());
      if (!task) return;
      this.active += 1;
      void this.execute(task)
        .catch((err) => logger.error(`[VlmBatch] 任务执行异常：${err instanceof Error ? err.message : err}`))
        .finally(() => {
          this.active -= 1;
        });
    }
  }

  /** 首次由调用方按 pollIntervalMs 驱动，故续期也放在这里 */
  private async electAndRenew(): Promise<void> {
    const { leaseTtlMs } = vlmBatchConfig.scheduler;

    if (!this.lease) {
      this.lease = await tryAcquireLeaderLease({
        key: vlmBatchConfig.scheduler.leaderKey,
        ttlMs: leaseTtlMs,
      });
      if (this.lease) {
        this.renewFailures = 0;
        this.lastRenewAt = Date.now();
        logger.info(`[VlmBatch] 获得 leader 租约（worker=${getWorkerId()}）`);
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
      logger.warn(`[VlmBatch] 租约续期失败（第 ${this.renewFailures} 次），下次重试`);
      return;
    }

    logger.error('[VlmBatch] 连续续期失败，让出 leader');
    await this.lease.release();
    this.lease = null;
    this.renewFailures = 0;
  }

  /**
   * 卡死任务恢复（仅 leader 调用）。
   *
   * ① 接手租约时立刻清扫**任何 workerId** 的 running 孤儿（此刻本进程没有在途任务，
   *    Mongo 里的 running 行必然是上一代进程遗留）。
   * ② 周期性按 updatedAt 阈值处理跨进程孤儿（阈值须大于一次完整批次耗时）。
   *
   * 以「重新入队」为主：重排后 execute 会跳过已 success 的项（断点续跑），只补跑未完成的，
   * 剩余项按 `client_job_id = taskId:index` 幂等重投，不重复消耗已完成的 GPU。
   */
  private async recoverStuckTasks(): Promise<void> {
    if (this.active > 0) return; // 本进程有在途任务，不做任何"恢复"，避免误伤自己
    const interval = Math.max(60_000, Math.floor(vlmBatchConfig.scheduler.taskStaleMs / 2));
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();

    const requeued = await vlmBatchTaskRepository.requeueOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeued > 0) {
      logger.warn(`[VlmBatch] 恢复：${requeued} 条中断任务已重新入队（含其他 worker 遗留）`);
    }
    const exhausted = await vlmBatchTaskRepository.failExhaustedOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhausted > 0) {
      logger.warn(`[VlmBatch] 恢复：${exhausted} 条达重试上限的任务已标记失败`);
    }

    const staleBefore = new Date(Date.now() - vlmBatchConfig.scheduler.taskStaleMs);
    const requeuedStale = await vlmBatchTaskRepository.requeueStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeuedStale > 0) {
      logger.warn(`[VlmBatch] 恢复：${requeuedStale} 条超时未更新的任务已重新入队`);
    }
    const exhaustedStale = await vlmBatchTaskRepository.failExhaustedStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhaustedStale > 0) {
      logger.warn(`[VlmBatch] 恢复：${exhaustedStale} 条超时且达重试上限的任务已标记失败`);
    }
  }

  /** 执行一条已领取的批次任务；任何异常都落到 markFailed，不向上抛 */
  private async execute(task: VlmBatchTaskDocument): Promise<void> {
    const taskId = String(task._id);
    let succeeded = 0;
    let failed = 0;

    try {
      // ---- ① 解析来源抽帧任务（快速失败，先于任何 GPU 消耗） ----
      await this.reportProgress(taskId, VLM_BATCH_PROGRESS_START, 'resolve_source');
      const framesTask = await aiDetectFrameTaskRepository.findById(task.sourceTaskId);
      if (!framesTask) throw new Error('来源抽帧任务不存在（可能已被删除），请重新提交');

      const items = flattenFrameItems(framesTask.frameScenes);
      if (items.length === 0) throw new Error('来源抽帧任务没有可识别的关键帧');

      if (!vlmConfig.configured) {
        throw new Error('图片理解未配置（需 VLM_MODE=remote 且设置 VLM_BASE_URL）');
      }

      // 已成功项的索引集合：断点续跑用（重排后跳过已完成的，不确定的不重跑）
      const doneIndexes = new Set(
        (task.items ?? []).filter((it) => it.status === 'success').map((it) => it.index),
      );

      // ---- ② 逐项识别（单项失败不拖垮整批） ----
      await this.reportProgress(taskId, batchProgress(0, items.length), 'recognize');
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i] as VlmBatchItemInput;
        if (doneIndexes.has(item.index)) {
          succeeded += 1;
          continue; // 已完成项：跳过（幂等键保证重投也不重复消耗 GPU，但没必要白跑）
        }

        const ok = await this.recognizeItem(taskId, task, item);
        if (ok) succeeded += 1;
        else failed += 1;

        await this.reportProgress(taskId, batchProgress(i + 1, items.length), 'recognize');
      }

      // ---- ③ 结算（有任意一项成功即 success，全失败才 failed） ----
      const stats = { succeeded, failed, finishedAt: new Date() };
      if (resolveBatchStatus(succeeded) === 'success') {
        await vlmBatchTaskRepository.markSuccess(taskId, stats);
        logger.info(`[VlmBatch] 批次完成 task=${taskId} 成功=${succeeded} 失败=${failed}`);
      } else {
        await vlmBatchTaskRepository.markFailed(taskId, '全部关键帧识别失败', stats.finishedAt, stats);
        logger.warn(`[VlmBatch] 批次失败 task=${taskId}（全部 ${failed} 项失败）`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[VlmBatch] 批次失败 task=${taskId}：${message}`);
      await vlmBatchTaskRepository
        .markFailed(taskId, message, new Date(), { succeeded, failed })
        .catch((markErr) => logger.error(`[VlmBatch] 标记失败态也失败了 task=${taskId}：${markErr}`));
    }
  }

  /**
   * 识别单张关键帧并回写该项结果；返回是否成功。
   *
   * 单项失败在这里被吞掉并记为 item 级失败（写入 message），绝不上抛 —— 一张坏图不该让整批中断。
   * 唯一的例外是进度回写被拒（任务已被取消/终结），此时 updateItemResult 返回 0；这不影响本项
   * 结果是否可用（它已经算出来了），仍按成功/失败计数，只是记录不再更新。
   */
  private async recognizeItem(
    taskId: string,
    task: VlmBatchTaskDocument,
    item: VlmBatchItemInput,
  ): Promise<boolean> {
    try {
      // 源帧校验放在每次调用前：文件可能在批次执行期间被清理
      const sourceFile = await fileService.getById(item.fileId);
      if (!sourceFile) throw new Error('关键帧文件记录不存在（可能已被删除）');
      const sourceAbs = path.resolve(fileService.getAbsolutePath(sourceFile));
      if (!fs.existsSync(sourceAbs)) throw new Error('关键帧文件已丢失');

      const result = await getVlmClient().understand(sourceAbs, {
        prompt: task.prompt,
        mode: task.mode,
        // 幂等键 = taskId:index：中断重排后重投命中容器里同一 job，不重复消耗 GPU
        clientJobId: `${taskId}:${item.index}`,
      });

      const calls = Number(result.attempts);
      const common = {
        rawText: result.text ?? '',
        modelCalls: calls > 0 ? calls : 1,
        modelId: result.model ?? '',
        elapsedMs: Number(result.elapsed_ms) || 0,
      };

      if (task.mode === 'text') {
        await this.writeItem(taskId, item.index, { status: 'success', message: '', ...common });
        return true;
      }

      // mode=json：容器已保证 parse_ok，但字段齐备/类型/克制与否要在这里收敛
      const normalized = normalizeVlmResult(result.json);
      if ('error' in normalized) {
        await this.writeItem(taskId, item.index, {
          status: 'failed',
          message: normalized.error,
          ...common,
        });
        return false;
      }

      await this.writeItem(taskId, item.index, {
        status: 'success',
        message: '',
        result: normalized.data,
        ...common,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[VlmBatch] 单项识别失败 task=${taskId} index=${item.index}：${message}`);
      await this.writeItem(taskId, item.index, {
        status: 'failed',
        message,
        rawText: '',
        modelCalls: 0,
        modelId: '',
        elapsedMs: 0,
      }).catch(() => {
        // 回写失败不影响计数：本项按失败结算
      });
      return false;
    }
  }

  /** 单项结果回写（隔离 ALS，避免把请求用户的 id 写进 updateBy） */
  private async writeItem(
    taskId: string,
    index: number,
    data: CompleteVlmBatchItemData,
  ): Promise<void> {
    await runIsolatedContext(() =>
      vlmBatchTaskRepository.updateItemResult(taskId, index, data).then(() => undefined),
    );
  }

  /**
   * 写一次整批进度。
   *
   * 逐项上报（每完成一张写一次），已天然稀疏，故不做节流 —— 与单图调度器的高频进度回调不同。
   * 隔离 ALS：避免把某个请求用户的 id 写进 updateBy。
   */
  private async reportProgress(taskId: string, progress: number, stage: string): Promise<void> {
    this.lastProgress = { pct: progress, stage };
    await runIsolatedContext(() =>
      vlmBatchTaskRepository
        .updateProgress(taskId, { progress, stage, message: vlmBatchStageLabel(stage) })
        .catch(() => {
          // 进度上报失败不影响识别本身
        }),
    );
  }
}

export const vlmBatchDispatcher = new VlmBatchDispatcher();

// 关机钩子：与图片理解/字幕/场景切分同样的排空语义
registerShutdownHook(() => vlmBatchDispatcher.stop());
