// utils/videoPipelineV2/videoPipelineV2.config.ts

/** 从 env 读整数，非法值/缺省回退默认值（?x=abc 类输入不应让配置变成 NaN） */
function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 从 env 读布尔，只有显式 'true'/'1' 才算真 */
function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true' || raw.trim() === '1';
}

/**
 * 视频生成管道 V2 配置（IndexTTS 配音 + Whisper 字幕 + ffmpeg 烧录）。
 *
 * 管道本身**不直接持有** GPU 引擎：配音复用 voiceTrainV2 合成任务、字幕复用 subtitle 任务，
 * 两个子任务各自有全机唯一的 leader 调度器。因此这里只描述「调度循环怎么跑」与
 * 「等子任务的上限」，没有模型/显存相关项。
 */
const videoPipelineV2Config = {
  /** 总开关：false 时提交接口直接 503，调度器也不启动 */
  enabled: envBool(process.env.VIDEO_PIPELINE_V2_ENABLED, true),

  scheduler: {
    /** 调度 tick 间隔（ms） */
    pollIntervalMs: envInt(process.env.VIDEO_PIPELINE_V2_POLL_INTERVAL_MS, 3_000),
    /** 在途任务数上限（每条最终都要跑一次 ffmpeg 合成，默认 1） */
    concurrency: Math.max(1, envInt(process.env.VIDEO_PIPELINE_V2_CONCURRENCY, 1)),
    /** 进度写库最小间隔（ms） */
    progressMinIntervalMs: envInt(process.env.VIDEO_PIPELINE_V2_PROGRESS_MIN_INTERVAL_MS, 1_000),
    /** leader 租约 TTL（ms），续期周期为 TTL/2 */
    leaseTtlMs: envInt(process.env.VIDEO_PIPELINE_V2_LEASE_TTL_MS, 60_000),
    /** 调度器 leader 租约键 */
    leaderKey: process.env.VIDEO_PIPELINE_V2_LEADER_KEY || 'wxbot:videoPipelineV2:leader',
    /** 陈旧任务判定阈值（ms），须大于一次完整管道耗时（配音 + 转写 + 合成） */
    taskStaleMs: envInt(process.env.VIDEO_PIPELINE_V2_TASK_STALE_MS, 3_600_000),
  },

  /**
   * 等待 IndexTTS 配音子任务的上限（ms）。
   * 必须 ≥ INDEXTTS_JOB_TIMEOUT_MS，否则合法的长配音会在子任务超时前先被管道判超时。
   */
  voiceTimeoutMs: envInt(process.env.VIDEO_PIPELINE_V2_VOICE_TIMEOUT_MS, 3_600_000),

  /**
   * 等待字幕子任务的上限（ms）。
   * 必须 ≥ SUBTITLE_TASK_STALE_MS，否则合法的长字幕任务会被管道侧提前判超时。
   */
  subtitleTimeoutMs: envInt(process.env.VIDEO_PIPELINE_V2_SUBTITLE_TIMEOUT_MS, 1_800_000),
} as const;

export default videoPipelineV2Config;
