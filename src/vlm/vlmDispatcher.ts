import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../../utils/Logger.ts';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { registerShutdownHook } from '../../utils/shutdownHooks.ts';
import { SHUTDOWN_TIMEOUT_MS, TASK_MAX_ATTEMPTS } from '../../utils/constant/ClusterConstants.ts';
import { vlmStageLabel } from '../../utils/constant/vlm.ts';
import vlmConfig from '../../utils/vlm/vlm.config.ts';
import { getVlmClient } from '../../utils/vlm/VlmHttpClient.ts';
import { normalizeVlmResult } from '../../utils/vlm/validateResult.ts';
import { runIsolatedContext } from '../../utils/requestContext.ts';
import { tryAcquireLeaderLease, type LeaderLease } from '../../utils/leaderLease.ts';
import { fileService } from '../file/file.service.ts';
import { vlmTaskRepository } from './vlmTask.repository.ts';
import type { VlmTaskDocument } from './vlmTask.entity.ts';

const logger = Logger.getInstance();

/** 连续续期失败几次才判定失去 leader 地位（容忍一次 Redis 抖动） */
const MAX_RENEW_FAILURES = 2;

/**
 * 进度分带（总和到 0.98，落库 markSuccess 固定置满）。
 *
 * 阶段：解析源图 → 提交 → 推理（容器回报的 0..1 映射到 0.15–0.90）→ 落库。
 * 推理段的起点不是 0 而是 0.15：容器首次收到任务时还要冷加载模型（数十秒到分钟级），
 * 那段时间的真实进度由容器的 `vlm_load` 阶段回报，这里只是给它留出区间。
 */
const PROGRESS_RESOLVE = 0.05;
const PROGRESS_SUBMIT = 0.15;
const GENERATE_BAND_START = 0.15;
const GENERATE_BAND_SPAN = 0.75;
const PROGRESS_PERSIST = 0.95;

/**
 * 图片理解任务调度器。
 *
 * 与 aiDetectDispatcher / subtitleDispatcher 同构：本服务跑在 node:cluster 下
 * （生产 CLUSTER_WORKERS=10），用 Redis 租约把调度循环收敛到唯一进程 —— 否则 10 个 worker
 * 会同时扫描队列、同时做全表恢复、同时写给同一批任务进度。
 *
 * 本调度器**不持有模型**：它只把图片 HTTP 发给独立的 Qwen3-VL 容器（services/vlm），
 * 自己负责提交、轮询、校验与落库。这是本项目「GPU 推理一律独立容器化」边界的一部分
 * （见 README「GPU 推理的边界」）。
 *
 * 刻意**不以容器 /readyz 为闸门**：该容器默认 `VLM_EAGER_LOAD=false`，未加载时 /readyz
 * 恒为 503 —— 拿它当就绪闸门会造成「不加载就不领取、不领取就永不加载」的死锁。
 * 正确做法是直接提交，让容器在第一个任务上懒加载，并把它回报的加载进度映射给任务。
 */
class VlmDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private lease: LeaderLease | null = null;
  private renewFailures = 0;
  private lastRenewAt = 0;
  /** 调度器并发上限（在途任务数），来自 VLM_CONCURRENCY */
  private readonly maxConcurrent = vlmConfig.scheduler.concurrency;
  /** 当前在途任务数（由 claimAndRun 维护，恒 ≤ maxConcurrent） */
  private active = 0;
  private running = false;
  /** 上次卡死任务清理时间（leader 专属，按 taskStaleMs/2 节流） */
  private lastRecoveryAt = 0;
  /** 最近一次推理进度（/engine/status 展示用） */
  private lastProgress: { pct: number; stage: string } | null = null;
  /**
   * 逐任务的进度节流状态（taskId → 上次落库时间与阶段）。
   *
   * 刻意按 taskId 分开而不是用两个全局字段：VLM_CONCURRENCY 是可配的（虽然默认与容器一致取 1），
   * 若共用一份状态，并发任务之间会互相重置节流窗口 —— 结果要么写得过频、要么把对方的阶段
   * 变化吞掉。任务结算时由 execute 的 finally 清理，避免长跑进程里 Map 无界增长。
   */
  private readonly progressState = new Map<string, { at: number; stage: string }>();

  /** 懒启动（幂等）。首次提交任务时调用 */
  start(): void {
    if (this.running) return;
    if (!vlmConfig.enabled) return;
    this.running = true;
    logger.info(`[Vlm] dispatcher 启动（worker=${getWorkerId()}）`);
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

  /** 最近一次推理进度 */
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
      // 一次理解含容器冷加载，可能数十秒到分钟级；超窗由下一次启动的中断恢复流程重新入队。
      // 结果按 clientJobId 幂等，重排后续跑会命中容器里的同一 job，不重复消耗 GPU。
      const deadline = Date.now() + Math.max(0, SHUTDOWN_TIMEOUT_MS - 1000);
      logger.info('[Vlm] 等待在途任务结算…');
      while (this.active > 0 && Date.now() < deadline) {
        await sleep(200);
      }
    }

    if (this.lease) {
      await this.lease.release();
      this.lease = null;
    }
    logger.info('[Vlm] dispatcher 已停止');
  }

  /** 调度循环：选举/续期 → 领取 pending 任务 → 执行 */
  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.electAndRenew();
      if (this.lease) await this.recoverStuckTasks();
      if (this.lease) await this.claimAndRun();
    } catch (err) {
      logger.error(`[Vlm] 调度循环异常：${err instanceof Error ? err.message : err}`);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), vlmConfig.scheduler.pollIntervalMs);
    this.timer.unref();
  }

  /** 在并发额度内领取并启动任务，直到配额用尽或队列为空（单线程内同步推进，无竞态） */
  private async claimAndRun(): Promise<void> {
    while (this.running && this.active < this.maxConcurrent) {
      const task = await vlmTaskRepository.claimNextPending(getWorkerId());
      if (!task) return;
      this.active += 1;
      // execute 自身不抛（异常都落到 markFailed），但 finally 派生出的 promise
      // 仍需兜底 catch —— 否则任何逸出异常都会变成 unhandledRejection 杀掉 worker
      void this.execute(task)
        .catch((err) => logger.error(`[Vlm] 任务执行异常：${err instanceof Error ? err.message : err}`))
        .finally(() => {
          this.active -= 1;
        });
    }
  }

  /** 首次由调用方按 pollIntervalMs 驱动，故续期也放在这里 */
  private async electAndRenew(): Promise<void> {
    const { leaseTtlMs } = vlmConfig.scheduler;

    if (!this.lease) {
      this.lease = await tryAcquireLeaderLease({ key: vlmConfig.scheduler.leaderKey, ttlMs: leaseTtlMs });
      if (this.lease) {
        this.renewFailures = 0;
        this.lastRenewAt = Date.now();
        logger.info(`[Vlm] 获得 leader 租约（worker=${getWorkerId()}）`);
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
      logger.warn(`[Vlm] 租约续期失败（第 ${this.renewFailures} 次），下次重试`);
      return;
    }

    logger.error('[Vlm] 连续续期失败，让出 leader');
    await this.lease.release();
    this.lease = null;
    this.renewFailures = 0;
  }

  /**
   * 卡死任务恢复（仅 leader 调用）。
   *
   * ① 接手租约时立刻清扫**任何 workerId** 的 running 孤儿（此刻本进程没有在途任务，
   *    Mongo 里的 running 行必然是上一代进程遗留）。
   * ② 周期性按 updatedAt 阈值处理跨进程孤儿（阈值须大于「冷加载 + 单图推理」）。
   *
   * 以「重新入队」为主：中断多发生在进程重启/发布期间，此时容器侧推理可能已完成，
   * 重排后的重投会命中同一个 job（clientJobId 幂等），不重复消耗 GPU。
   */
  private async recoverStuckTasks(): Promise<void> {
    if (this.active > 0) return; // 本进程有在途任务，不做任何"恢复"，避免误伤自己
    const interval = Math.max(60_000, Math.floor(vlmConfig.scheduler.taskStaleMs / 2));
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();

    const requeued = await vlmTaskRepository.requeueOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeued > 0) {
      logger.warn(`[Vlm] 恢复：${requeued} 条中断任务已重新入队（含其他 worker 遗留）`);
    }
    const exhausted = await vlmTaskRepository.failExhaustedOrphanRunning(
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhausted > 0) {
      logger.warn(`[Vlm] 恢复：${exhausted} 条达重试上限的任务已标记失败`);
    }

    const staleBefore = new Date(Date.now() - vlmConfig.scheduler.taskStaleMs);
    const requeuedStale = await vlmTaskRepository.requeueStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务中断，已自动重新排队',
    );
    if (requeuedStale > 0) {
      logger.warn(`[Vlm] 恢复：${requeuedStale} 条超时未更新的任务已重新入队`);
    }
    const exhaustedStale = await vlmTaskRepository.failExhaustedStuckRunning(
      staleBefore,
      TASK_MAX_ATTEMPTS,
      '任务多次中断（已达重试上限），请重新提交',
    );
    if (exhaustedStale > 0) {
      logger.warn(`[Vlm] 恢复：${exhaustedStale} 条超时且达重试上限的任务已标记失败`);
    }
  }

  /** 执行一条已领取的任务；任何异常都落到 markFailed，不向上抛 */
  private async execute(task: VlmTaskDocument): Promise<void> {
    const taskId = String(task._id);
    /**
     * 失败时的模型原始输出。
     *
     * 模型产出内容但**不合字段契约**时（典型现象是字段名被改写），这条输出是排障与手工挽救
     * 的唯一依据；只在 `message` 里塞 300 字摘录不够。放在 try 外是为了让 catch 也能拿到。
     */
    let failureRawText = '';

    try {
      // ---- ① 解析源图片（快速失败，先于任何 GPU 消耗） ----
      await this.reportProgress(taskId, PROGRESS_RESOLVE, 'resolve_source', false);
      const sourceFile = await fileService.getById(task.sourceFileId);
      if (!sourceFile) throw new Error('源图片文件记录不存在（可能已被删除），请重新提交');
      const sourceAbs = path.resolve(fileService.getAbsolutePath(sourceFile));
      if (!fs.existsSync(sourceAbs)) throw new Error('源图片文件已丢失，请重新上传');

      const client = getVlmClient();
      if (!vlmConfig.configured) {
        throw new Error('图片理解未配置（需 VLM_MODE=remote 且设置 VLM_BASE_URL）');
      }

      // ---- ② 提交 + 轮询 + 取回结果 ----
      await this.reportProgress(taskId, PROGRESS_SUBMIT, 'submit', false);
      const result = await client.understand(sourceAbs, {
        prompt: task.prompt,
        mode: task.mode,
        // 幂等键用 Mongo taskId：中断重排后重投会命中容器里的同一个 job，不重复消耗 GPU
        clientJobId: taskId,
        onProgress: (pct, stage) => {
          // 容器的 stage 是 ASCII key（vlm_load / vlm_generate / vlm_parse），
          // 中文映射统一在 Node 侧拼装
          const mapped = GENERATE_BAND_START + Math.max(0, Math.min(1, pct)) * GENERATE_BAND_SPAN;
          this.lastProgress = { pct: mapped, stage };
          void this.reportProgress(taskId, mapped, stage, true);
        },
      });

      // ---- ③ 落库（含结果收敛） ----
      await this.reportProgress(taskId, PROGRESS_PERSIST, 'persist', false);

      // 容器侧 attempts 为「实际调用模型的次数」；缺省/非法值兜底为 1（至少调了一次）
      const containerCalls = Number(result.attempts);
      const common = {
        rawText: result.text ?? '',
        modelCalls: containerCalls > 0 ? containerCalls : 1,
        modelId: result.model ?? '',
        elapsedMs: Number(result.elapsed_ms) || 0,
        finishedAt: new Date(),
      };

      if (task.mode === 'text') {
        await vlmTaskRepository.markSuccess(taskId, common);
        logger.info(`[Vlm] 理解完成（text）task=${taskId}`);
        return;
      }

      // mode=json：容器已保证 parse_ok，但字段齐备/类型/克制与否要在这里收敛
      failureRawText = result.text ?? '';
      const normalized = normalizeVlmResult(result.json);
      if ('error' in normalized) {
        // 不静默成功。报错里同时给出「怎么改」：这条路最容易被误当成功能坏了，
        // 而实际需求（想要一段自由描述）用 mode=text 就能满足。
        const excerpt = failureRawText.trim().replace(/\s+/g, ' ').slice(0, 300);
        throw new Error(
          `${normalized.error}。若你只需要一段自由描述（不需要固定字段），请改用 mode=text。` +
            `原始输出片段：${excerpt || '（空）'}`,
        );
      }

      await vlmTaskRepository.markSuccess(taskId, { ...common, result: normalized.data });
      logger.info(
        `[Vlm] 理解完成 task=${taskId} model=${result.model || '-'} 调用=${common.modelCalls} 次 耗时=${common.elapsedMs}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Vlm] 理解失败 task=${taskId}：${message}`);
      await vlmTaskRepository
        .markFailed(taskId, message, new Date(), failureRawText)
        .catch((markErr) => logger.error(`[Vlm] 标记失败态也失败了 task=${taskId}：${markErr}`));
    } finally {
      // 任务已结算，节流状态没用了 —— 不清理的话长跑进程里这个 Map 会随任务数无界增长
      this.progressState.delete(taskId);
    }
  }

  /**
   * 写一次进度。
   *
   * `throttled=true` 用于容器回报的高频进度：按 progressMinIntervalMs 节流，避免长推理期间
   * 把 Mongo 写爆。阶段切换（vlm_load → vlm_generate）不受节流限制 —— 那种变化频率低、
   * 且是用户最需要看到的信息。节流状态按 taskId 隔离（见 progressState 的说明）。
   */
  private async reportProgress(
    taskId: string,
    progress: number,
    stage: string,
    throttled: boolean,
  ): Promise<void> {
    const prev = this.progressState.get(taskId);
    if (throttled && prev) {
      const sameStage = stage === prev.stage;
      if (sameStage && Date.now() - prev.at < vlmConfig.scheduler.progressMinIntervalMs) {
        return;
      }
    }
    this.progressState.set(taskId, { at: Date.now(), stage });
    this.lastProgress = { pct: progress, stage };

    // 隔离 ALS：避免把某个请求用户的 id 写进 updateBy（见 start() 的说明）
    await runIsolatedContext(() =>
      vlmTaskRepository
        .updateProgress(taskId, { progress, stage, message: vlmStageLabel(stage) })
        .catch(() => {
          // 进度上报失败不影响理解本身
        }),
    );
  }
}

export const vlmDispatcher = new VlmDispatcher();

// 关机钩子：与字幕/IndexTTS/数字人/场景切分同样的排空语义
registerShutdownHook(() => vlmDispatcher.stop());
