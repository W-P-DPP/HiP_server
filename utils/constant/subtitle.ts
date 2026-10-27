// utils/constant/subtitle.ts
/** 字幕生成（音频 → SRT）业务常量 */
import { envStr } from './envParse.ts';

/** 提交时上传的源音频在 file 表中的分类标识 */
export const SUBTITLE_SOURCE_CATEGORY = 'subtitleSource';

/** 提交时上传的源视频在 file 表中的分类标识（与音频 subtitleSource 区分，便于按来源排查） */
export const SUBTITLE_VIDEO_SOURCE_CATEGORY = 'subtitleVideoSource';

/** 生成的 SRT 字幕在 file 表中的分类标识 */
export const SUBTITLE_SRT_CATEGORY = 'subtitleSrt';

/** SRT 字幕的 MIME 类型（file 记录用） */
export const SUBTITLE_SRT_MIME = 'application/x-subrip';

/**
 * 允许转写的音频 MIME 白名单。
 *
 * 含 `application/octet-stream`：部分客户端对 m4a/aac 会上报该通用类型。
 * 音频（含未知类型）一律按音频处理，最终能否识别由 ASR 服务判定。
 */
export const SUBTITLE_AUDIO_MIME_WHITELIST: readonly string[] = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
  'application/octet-stream',
];

/** 判断 MIME 是否可转写：白名单命中或任意 audio/* 子类型 */
export function isSupportedAudioMime(mimeType: string): boolean {
  const mime = (mimeType || '').trim().toLowerCase();
  return mime.startsWith('audio/') || SUBTITLE_AUDIO_MIME_WHITELIST.includes(mime);
}

/**
 * 视频扩展名 / 音频扩展名。
 *
 * MIME 不可全信：不少客户端对 mp4/mov 会上报 `application/octet-stream`，此时扩展名是唯一判据。
 * 与 utils/constant/video.ts 的 VIDEO_FILE_EXT 用途不同 —— 那个用于「是否走硬件解码」，
 * 只认容器为视频的场景；这里用于「提交的到底是音频还是视频」，故额外收录 m4v/3gp。
 */
const SUBTITLE_VIDEO_EXT = /\.(mp4|mov|mkv|avi|webm|mpeg|mpg|ts|flv|wmv|m4v|3gp)$/i;
const SUBTITLE_AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|wma|amr|opus)$/i;

/**
 * 判断是否为可提取音频的视频：`video/*` 直接命中，否则看扩展名。
 *
 * 上报 `audio/*` 时一律判否 —— 多媒体容器（如 .mp4 装纯音频）由 MIME 决定归属，
 * 不让扩展名把音频文件误判成视频走提取分支。
 */
export function isSupportedVideoMime(mimeType: string, originalName = ''): boolean {
  const mime = (mimeType || '').trim().toLowerCase();
  if (mime.startsWith('video/')) return true;
  if (mime.startsWith('audio/')) return false;
  return SUBTITLE_VIDEO_EXT.test(originalName || '');
}

/**
 * 判定提交的源媒体类型。
 *
 * 判据优先级：MIME（video/* / audio/*）> 扩展名 > null（未知）。
 * 未知类型不给默认值：宁可 400 让用户看到明确提示，也不要猜一个类型去跑 ffmpeg。
 */
export function resolveSubtitleMediaType(
  mimeType: string,
  originalName = '',
): 'audio' | 'video' | null {
  const mime = (mimeType || '').trim().toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const name = originalName || '';
  if (SUBTITLE_VIDEO_EXT.test(name)) return 'video';
  if (SUBTITLE_AUDIO_EXT.test(name)) return 'audio';
  return null;
}

/** 从视频提取音频的临时子目录：点号开头，express.static 的 dotfiles 默认 ignore 不会把它暴露出去 */
export const SUBTITLE_EXTRACT_SUBDIR = '.subtitle';

/**
 * 「视频里没有可用音轨」的统一提示。
 *
 * 两种情形共用同一句话：ffmpeg 直接失败（`-vn` 后无输出流）与产出 0 秒音频（畸形容器）。
 * 对用户而言这是同一个问题，不该因为内部走了哪条分支而看到两种说法。
 */
export const SUBTITLE_NO_AUDIO_MESSAGE = '视频中未检测到可用音轨，请更换包含人声的视频';

/**
 * 提取音频的统一采样率。
 *
 * 16kHz 单声道是语音识别模型的输入惯例（Whisper 内部即重采样到 16k），
 * 提前归一化可减少上传体积与服务端解码开销；数值与 DIGITAL_HUMAN_AUDIO_SAMPLE_RATE 一致，
 * 但两者是两个独立约定（对口型驱动 vs ASR 输入），故各自命名、不互相引用。
 */
export const SUBTITLE_EXTRACT_SAMPLE_RATE = 16_000;

/**
 * 任务阶段中文标签。
 *
 * stage 在库里只存 ASCII key，中文映射集中在 Node 侧 —— 与 `digitalHumanStageLabel` /
 * `indexttsStageLabel` 同一策略，便于前端直接展示。
 */
const SUBTITLE_STAGE_LABELS: Record<string, string> = {
  pending: '排队中',
  resolve_audio: '解析音频',
  extract_audio: '提取音频',
  asr: '语音识别中',
  persist: '保存字幕',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** ASCII stage key → 中文描述；未知 key 原样返回，便于排障时发现漏配 */
export function subtitleStageLabel(stage: string): string {
  return SUBTITLE_STAGE_LABELS[stage] ?? stage;
}

/** ASR 通道选择：auto = 本地 Whisper 优先、云端讯飞兜底 */
export type AsrProviderName = 'auto' | 'xunfei' | 'whisper';

/** 字幕生成（ASR）环境变量常量 */
export class SubtitleConstants {
  /** 总开关（固定开启） */
  public static readonly ENABLED: boolean = true;

  /** 通道选择：auto / xunfei / whisper（固定 auto：本地 Whisper 优先、云端讯飞兜底） */
  public static readonly PROVIDER: AsrProviderName = 'auto';

  /** 语种；讯飞口径，autodialect=自动语种 */
  public static readonly LANGUAGE: string = 'autodialect';

  /** 单音频大小上限（字节，业务上限） */
  public static readonly MAX_AUDIO_BYTES: number = 50 * 1024 * 1024;

  /** 单视频大小上限（字节） */
  public static readonly MAX_VIDEO_BYTES: number = 200 * 1024 * 1024;

  /** 讯飞 getResult 轮询间隔（ms） */
  public static readonly POLL_INTERVAL_MS: number = 15_000;

  /** 讯飞 getResult 最大轮询次数 */
  public static readonly MAX_POLL_COUNT: number = 90;

  /** 讯飞轮询连续错误容忍次数 */
  public static readonly MAX_CONSECUTIVE_ERRORS: number = 3;

  /** 后台任务调度器 */
  public static readonly SCHEDULER = {
    /** 调度 tick 间隔（ms） */
    POLL_INTERVAL_MS: 3_000,
    /** 在途任务数上限（转写是网络 IO，可适度并行） */
    CONCURRENCY: 2,
    /** 进度写库最小间隔（ms） */
    PROGRESS_MIN_INTERVAL_MS: 1_000,
    /** leader 租约 TTL（ms） */
    LEASE_TTL_MS: 60_000,
    /** 调度器 leader 租约键 */
    LEADER_KEY: envStr('SUBTITLE_LEADER_KEY', 'wxbot:subtitle:leader'),
    /** 陈旧任务判定阈值（ms） */
    TASK_STALE_MS: 30 * 60_000,
  } as const;
}
