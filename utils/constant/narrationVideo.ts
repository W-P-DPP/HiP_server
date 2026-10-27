// utils/constant/narrationVideo.ts
// 解说视频（narrationVideo）业务常量：阶段标签、file 分类、默认成片规格与字幕切分口径。

/**
 * 任务阶段中文标签。
 *
 * stage 在库里只存 ASCII key，中文映射集中在 Node 侧 —— 与 videoPipelineV2StageLabel 同策略，
 * 便于前端直接展示。
 */
const NARRATION_VIDEO_STAGE_LABELS: Record<string, string> = {
  pending: '排队中',
  resolve: '解析源视频',
  segment: '分段合成中',
  render: '拼接成片',
  burn: '烧录字幕',
  persist: '保存产物',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** ASCII stage key → 中文描述；未知 key 原样返回，便于排障时发现漏配 */
export function narrationVideoStageLabel(stage: string): string {
  return NARRATION_VIDEO_STAGE_LABELS[stage] ?? stage;
}

/** 成片视频在 file 表里的分类 */
export const NARRATION_VIDEO_CATEGORY = 'narrationVideo';
/** 解说字幕 SRT 在 file 表里的分类 */
export const NARRATION_VIDEO_SRT_CATEGORY = 'narrationVideoSrt';

/** 成片统一规格（所有片段归一化到此规格，concat `-c copy` 才能安全拼接） */
export const NARRATION_VIDEO_WIDTH = 1280;
export const NARRATION_VIDEO_HEIGHT = 720;
export const NARRATION_VIDEO_FPS = 30;
/** 成片音频码率 */
export const NARRATION_VIDEO_AUDIO_BITRATE = '192k';
/** 成片音频采样率（解说段配音与细节段原声统一，concat `-c copy` 音轨参数必须一致） */
export const NARRATION_VIDEO_AUDIO_SAMPLE_RATE = 48_000;
/** 成片音频声道数 */
export const NARRATION_VIDEO_AUDIO_CHANNELS = 2;

/**
 * 源画面归一化到成片规格的滤镜链（解说段/细节段共用）。
 * 字幕遮罩在此基础上以逗号追加（见 buildSubtitleMaskFilter）。
 */
export const NARRATION_VIDEO_NORMALIZE_VF = `scale=${NARRATION_VIDEO_WIDTH}:${NARRATION_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${NARRATION_VIDEO_WIDTH}:${NARRATION_VIDEO_HEIGHT},setsar=1,setpts=PTS-STARTPTS`;

/** 字幕遮罩模式：blur 区域模糊覆盖 / box 纯色块覆盖 */
export const NARRATION_VIDEO_SUBTITLE_MASK_MODES = ['blur', 'box'] as const;
export type NarrationSubtitleMaskMode = (typeof NARRATION_VIDEO_SUBTITLE_MASK_MODES)[number];

/** 字幕遮罩默认几何（成片 1280x720 坐标；底部整宽字幕带）与默认模糊强度 */
export const NARRATION_VIDEO_SUBTITLE_MASK_DEFAULT = {
  x: 0,
  y: 600,
  w: 1280,
  h: 120,
  blur: 12,
} as const;

/** 字幕每行目标字数（文本切分法按此宽度断行，过短行会向前合并） */
export const NARRATION_VIDEO_SUBTITLE_CHARS = 18;
/** 单段字幕最少字数阈值：短于它且还有上一行时向前合并，避免出现孤零零一两字的字幕 */
export const NARRATION_VIDEO_SUBTITLE_MIN_CHARS = 6;

/** 分段数量上限（防止异常入参把一次任务撑成上千次 TTS + ffmpeg） */
export const NARRATION_VIDEO_MAX_SEGMENTS = 500;
/** 单段 clip 数量上限 */
export const NARRATION_VIDEO_MAX_CLIPS_PER_SEGMENT = 200;
