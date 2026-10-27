// utils/vlm/vlmBatch.config.ts
/**
 * 批量图像识别（基于场景抽帧关键帧）配置。
 *
 * 与 `vlm.config.ts` 的关系：**客户端设置完全复用**（同一个 Qwen3-VL 容器、同一套地址/超时/
 * 体积上限/默认指令，由调度器与 service 直接读 `vlmConfig`），本文件只新增「本队列自己的调度器」
 * ——独立并发额度、独立 leader 租约键。
 *
 * 为什么单独一条队列而不是复用单图队列：一个批次要串行识别成百上千张关键帧，若与单图任务
 * 共用额度，一个批次会把单图任务全部堵在它后面。两条队列各自领取、各自排队、互不挤占
 * （与 aiDetect 的场景切分/抽帧分队列同一取舍）。
 */

/** 从 env 读整数，非法值/缺省回退默认值（?x=abc 类输入不应让配置变成 NaN） */
function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 从 env 读布尔，只有显式 'true'/'1' 才算真 */
function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1';
}

const vlmBatchConfig = {
  /** 模块总开关：false 时提交接口 503，调度器不启动 */
  enabled: envBool(process.env.VLM_BATCH_ENABLED, true),

  /** 后台任务调度器（leader 租约 + FIFO 领取，见 src/vlmBatch/vlmBatchDispatcher.ts） */
  scheduler: {
    /** 调度 tick 间隔（ms） */
    pollIntervalMs: envInt(process.env.VLM_BATCH_DISPATCH_POLL_INTERVAL_MS, 3_000),
    /**
     * 在途批次任务数上限。容器侧 GPU 并发恒为 1，这里放大并发只会把各批次的单张请求
     * 交错堆进容器队列 —— 默认 1，与 `vlm.config.ts` 的 VLM_CONCURRENCY 各算各的。
     */
    concurrency: Math.max(1, envInt(process.env.VLM_BATCH_CONCURRENCY, 1)),
    /** leader 租约 TTL（ms），续期周期为 TTL/2 */
    leaseTtlMs: envInt(process.env.VLM_BATCH_LEASE_TTL_MS, 60_000),
    /** 调度器 leader 租约键（与 wxbot:vlm:leader 等各调度器各自独立） */
    leaderKey: process.env.VLM_BATCH_LEADER_KEY || 'wxbot:vlmBatch:leader',
    /**
     * 陈旧任务判定阈值（ms）。
     *
     * 必须大于「一次完整批次的耗时」—— 一个批次是 N 张图的串行推理（含容器冷加载），
     * 场景多时可达小时级，故默认取 2 小时（远大于单图队列的 30 分钟）。阈值给小了，
     * 中断恢复会把正在跑的批次误判为孤儿并重排。
     */
    taskStaleMs: envInt(process.env.VLM_BATCH_TASK_STALE_MS, 2 * 60 * 60_000),
  },
} as const;

export default vlmBatchConfig;
