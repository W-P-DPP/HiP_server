// utils/narrationVideo/narrationVideo.config.ts
import type { NarrationSubtitleMaskMode } from '../constant/narrationVideo.ts';

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

/**
 * 解说视频配置。
 *
 * 本模块**不直接持有 GPU 引擎**：配音复用 voiceTrainV2 合成任务（IndexTTS），画面裁剪/拼接/烧录
 * 全走本机 ffmpeg。因此这里只描述「调度循环怎么跑」「等配音子任务的上限」与「字幕烧录样式」，
 * 没有模型/显存相关项。
 */
const narrationVideoConfig = {
  /** 总开关：false 时提交接口直接 503，调度器也不启动 */
  enabled: envBool(process.env.NARRATION_VIDEO_ENABLED, true),

  scheduler: {
    /** 调度 tick 间隔（ms） */
    pollIntervalMs: envInt(process.env.NARRATION_VIDEO_POLL_INTERVAL_MS, 3_000),
    /** 在途任务数上限（每条任务内含 N 次 TTS + 多次 ffmpeg，默认 1） */
    concurrency: Math.max(1, envInt(process.env.NARRATION_VIDEO_CONCURRENCY, 1)),
    /** 进度写库最小间隔（ms） */
    progressMinIntervalMs: envInt(process.env.NARRATION_VIDEO_PROGRESS_MIN_INTERVAL_MS, 1_000),
    /** leader 租约 TTL（ms），续期周期为 TTL/2 */
    leaseTtlMs: envInt(process.env.NARRATION_VIDEO_LEASE_TTL_MS, 60_000),
    /** 调度器 leader 租约键 */
    leaderKey: process.env.NARRATION_VIDEO_LEADER_KEY || 'wxbot:narrationVideo:leader',
    /**
     * 陈旧任务判定阈值（ms），须大于一次完整任务耗时（N 段配音 + 多次 ffmpeg + 烧录）。
     * 默认 2 小时。
     */
    taskStaleMs: envInt(process.env.NARRATION_VIDEO_TASK_STALE_MS, 7_200_000),
  },

  /**
   * 等待单段 IndexTTS 配音子任务的上限（ms）。
   * 必须 ≥ INDEXTTS_JOB_TIMEOUT_MS，否则合法的长配音会在子任务超时前先被本侧判超时。
   */
  voiceTimeoutMs: envInt(process.env.NARRATION_VIDEO_VOICE_TIMEOUT_MS, 3_600_000),

  /** 字幕烧录样式（缺省即 utils/videoHelper/burnSubtitles.ts 的默认值） */
  subtitle: {
    fontSize: envInt(process.env.NARRATION_VIDEO_SUBTITLE_FONT_SIZE, 24) || undefined,
    fontName: process.env.NARRATION_VIDEO_SUBTITLE_FONT_NAME || undefined,
    colorHex: process.env.NARRATION_VIDEO_SUBTITLE_COLOR || undefined,
    position: process.env.NARRATION_VIDEO_SUBTITLE_POSITION === 'top' ? 'top' : ('bottom' as const),
    marginV: envInt(process.env.NARRATION_VIDEO_SUBTITLE_MARGIN_V, 24) || undefined,
  },

  /**
   * 源视频烧死字幕的遮罩（仅作用于「解说段」的整段画面；细节段保留源字幕）。
   * 几何为成片 1280x720 坐标；blur=区域模糊覆盖（默认），box=纯色块覆盖。
   */
  subtitleMask: {
    enabled: envBool(process.env.NARRATION_VIDEO_SUBTITLE_MASK_ENABLED, true),
    mode: (process.env.NARRATION_VIDEO_SUBTITLE_MASK_MODE === 'box'
      ? 'box'
      : 'blur') as NarrationSubtitleMaskMode,
    x: envInt(process.env.NARRATION_VIDEO_SUBTITLE_MASK_X, 0),
    y: envInt(process.env.NARRATION_VIDEO_SUBTITLE_MASK_Y, 600),
    w: envInt(process.env.NARRATION_VIDEO_SUBTITLE_MASK_W, 1280),
    h: envInt(process.env.NARRATION_VIDEO_SUBTITLE_MASK_H, 120),
    blurStrength: Math.max(1, envInt(process.env.NARRATION_VIDEO_SUBTITLE_MASK_BLUR, 12)),
  },
} as const;

export default narrationVideoConfig;
