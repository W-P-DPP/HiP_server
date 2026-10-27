// utils/asr/asr.config.ts
/** 字幕生成（ASR）配置（环境变量读取点在 utils/constant/subtitle.ts 的 SubtitleConstants） */
import { SubtitleConstants } from '../constant/subtitle.ts';

/** ASR 通道选择：auto = 本地 Whisper 优先、云端讯飞兜底 */
export type AsrProviderName = 'auto' | 'xunfei' | 'whisper';

/**
 * 字幕生成（ASR）配置。
 *
 * 两类参数刻意分组：`asr*` 描述「一次转写怎么问云端」，`scheduler` 描述「后台队列怎么跑」。
 * 两边都有「轮询间隔」概念但语义不同（讯飞订单轮询 vs 调度 tick），分组可避免混用。
 */
const asrConfig = {
  /** 总开关：false 时提交接口直接 503，调度器也不启动 */
  enabled: SubtitleConstants.ENABLED,

  /** 通道选择：auto / xunfei / whisper */
  provider: SubtitleConstants.PROVIDER,

  /** 语种；讯飞口径默认 autodialect（自动语种） */
  language: SubtitleConstants.LANGUAGE,

  /**
   * 单文件大小上限（字节），超出在提交时就拒绝。
   *
   * 这是**业务上限**，与 multer 的 FILE_MAX_SIZE（传输上限）独立：
   * - 默认 50MB，与 FILE_MAX_SIZE 一致 ⇒ 等于不额外设限；
   * - 转写按音频时长计费，需要控成本时可把本值调到**小于** FILE_MAX_SIZE 来收紧。
   *   设得比 FILE_MAX_SIZE 大没有意义 —— 文件在 multer 那层就被拒了。
   */
  maxAudioBytes: SubtitleConstants.MAX_AUDIO_BYTES,

  /**
   * 单视频大小上限（字节），超出在提交时就拒绝。
   *
   * 它是 POST /subtitles/tasks/from-media 的**传输**上限（专用 multer 实例
   * uploadSubtitleMedia 直接用它，音频/视频共用这条传输上限），也是该路由上视频的**业务**上限；
   * 音频在该路由上仍按 maxAudioBytes 校验（超限的音频会被业务校验拒绝并清掉）。
   */
  maxVideoBytes: SubtitleConstants.MAX_VIDEO_BYTES,

  // ---- 讯飞订单轮询 ----
  /** 轮询 getResult 的间隔（ms），与 voiceTrain 的 RAASR_POLL_INTERVAL_MS 对齐 */
  pollIntervalMs: SubtitleConstants.POLL_INTERVAL_MS,
  /** 最大轮询次数，超出判定超时 */
  maxPollCount: SubtitleConstants.MAX_POLL_COUNT,
  /** 连续网络/未知错误容忍次数，超出即放弃（避免偶发抖动拖垮长轮询） */
  maxConsecutiveErrors: SubtitleConstants.MAX_CONSECUTIVE_ERRORS,

  // ---- 后台任务调度器 ----
  scheduler: {
    /** 调度 tick 间隔（ms） */
    pollIntervalMs: SubtitleConstants.SCHEDULER.POLL_INTERVAL_MS,
    /** 在途任务数上限（转写是网络 IO，可适度并行） */
    concurrency: SubtitleConstants.SCHEDULER.CONCURRENCY,
    /** 进度写库最小间隔（ms） */
    progressMinIntervalMs: SubtitleConstants.SCHEDULER.PROGRESS_MIN_INTERVAL_MS,
    /** leader 租约 TTL（ms），续期周期为 TTL/2 */
    leaseTtlMs: SubtitleConstants.SCHEDULER.LEASE_TTL_MS,
    /** 调度器 leader 租约键 */
    leaderKey: SubtitleConstants.SCHEDULER.LEADER_KEY,
    /** 陈旧任务判定阈值（ms），须大于一次完整转写耗时 */
    taskStaleMs: SubtitleConstants.SCHEDULER.TASK_STALE_MS,
  },
} as const;

export default asrConfig;
