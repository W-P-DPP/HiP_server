/** 音色训练 V2 业务常量 */

/** 训练音频最短时长（秒）：低于该值不允许上传 */
export const MIN_TRAIN_AUDIO_DURATION_SEC = 10;

/** 归一化参考音（reference.wav）在 file 表中的分类标识 */
export const VOICE_TRAIN_V2_REFERENCE_CATEGORY = 'voiceTrainV2Reference';

/** 合成试听产物在 file 表中的分类标识 */
export const VOICE_TRAIN_V2_PREVIEW_CATEGORY = 'voiceTrainV2Preview';

/**
 * 参考音统一采样率。
 *
 * IndexTTS2 内部会把参考音裁到 ≤15s 并做特征提取，22.05kHz mono 是上游约定的
 * 「存盘即可直接用」形态（见 JY_IPAgent tts/voices.py 的 sample_rate=22050）。
 */
export const VOICE_REFERENCE_SAMPLE_RATE = 22050;

/**
 * 归一化后的最小文件体积（字节）。低于此值说明 ffmpeg 产出无效，
 * 上游用的是 100，这里取 256 —— 22.05kHz mono 的 wav 头就有 44 字节，
 * 过小的产出必然是空音频。
 */
export const MIN_REFERENCE_FILE_BYTES = 256;

/** 试听产物扩展名 */
export const VOICE_PREVIEW_EXT = '.wav';

/**
 * 合成任务用途：preview 试听（成功后把结果回写到音色试听字段）/ synthesis 正式合成（不回写）。
 *
 * 同一套合成链路既服务于「试听这个音色像不像」，也服务于正式内容合成。二者必须区分：
 * 正式合成若回写，会覆盖用户在列表里听到的试听效果，所以由调用方显式声明用途。
 */
export const SYNTHESIS_PURPOSES = ['preview', 'synthesis'] as const;

export type SynthesisPurpose = (typeof SYNTHESIS_PURPOSES)[number];

/**
 * 用途缺省值。刻意保守取 synthesis：调用方不显式声明 preview 就绝不回写音色的试听字段，
 * 避免漏传参数时正式合成覆盖试听（宁可试听少回写，也不能被污染）。
 */
export const DEFAULT_SYNTHESIS_PURPOSE: SynthesisPurpose = 'synthesis';
