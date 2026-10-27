// utils/constant/aiDetect.ts
/** AI 检测（视频场景切分）业务常量 */
import path from 'node:path';
import type { SceneDetect } from '../../type/index.d.ts';

/** 提交的源视频在 file 表中的分类标识 */
export const AI_DETECT_SOURCE_CATEGORY = 'aiDetectSource';

/** 抽帧产物（每个场景的开始/中间/结束帧）在 file 表中的分类标识 */
export const AI_DETECT_FRAME_CATEGORY = 'aiDetectFrame';

/** 抽帧产物的 MIME。固定 jpg：抽帧只输出这一种格式，登记与下载都按它走 */
export const AI_DETECT_FRAME_MIME = 'image/jpeg';

/**
 * 转写用的音频块在 file 表中的分类标识。
 *
 * 转写走的 subtitle 链路只接受 fileId（不接受裸路径），所以每块音频都必须登记进 file 表 ——
 * 它们同时也是可回溯的中间产物（哪个任务的第几块、来自哪段时间区间都写在 metadata 里）。
 */
export const AI_DETECT_ASR_AUDIO_CATEGORY = 'aiDetectAsrAudio';

/** 转写音频块的 MIME（16k 单声道 wav，与 SUBTITLE_EXTRACT_SAMPLE_RATE 同口径） */
export const AI_DETECT_ASR_AUDIO_MIME = 'audio/wav';

/**
 * 源视频分片会话在 uploads 下的点号子目录。
 *
 * 点号开头 + express.static 的 dotfiles 默认 ignore，分片与半成品不会被 `/static/files` 暴露；
 * 与素材库的 `.videoMaterialChunks` 分开命名，既能各自回收，排障时也能一眼看出分片来自哪个入口。
 */
export const AI_DETECT_CHUNK_SUBDIR = '.aiDetectChunks';

/**
 * 源视频扩展名 → MIME。
 *
 * 分片是逐片到达的，单片请求带不上「整份文件」的 MIME，只能在 init 时按文件名扩展名定，
 * 故这里必须显式列出检测链路（ffmpeg + PySceneDetect）认得的容器；**未知扩展名在 init 直接 400**，
 * 不给 application/octet-stream 兜底 —— 入库一个解不开的文件，不如当场拒绝。
 *
 * 与素材库的 VIDEO_MATERIAL_MIME_BY_EXT 差别：只收视频（场景切分不接受图片），故不收录图片扩展名。
 */
export const AI_DETECT_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
};

/** 从文件名推导源视频 MIME；未知扩展名返回空串（调用方据此拒绝） */
export function aiDetectMimeFromName(fileName: string): string {
  const ext = path.extname((fileName ?? '').trim()).toLowerCase();
  return AI_DETECT_MIME_BY_EXT[ext] ?? '';
}

/**
 * 支持的检测算法。
 * 必须与 services/scenedetect/detect_scenes.py 的 `--detector choices` 保持一致，
 * 否则 Node 侧放行的取值会被脚本以 argparse 报错拒绝。
 */
export const AI_DETECT_ALLOWED_DETECTORS: readonly SceneDetect.Detector[] = [
  'content',
  'adaptive',
  'threshold',
];

/** 类型守卫：判断任意字符串是否是受支持的检测算法 */
const isDetector = (value: string): value is SceneDetect.Detector =>
  (AI_DETECT_ALLOWED_DETECTORS as readonly string[]).includes(value);

/**
 * 归一化检测算法：未知/空值回退 content（或给定缺省值）。
 *
 * 与 utils/videoHelper/sceneDetect.ts 的 resolveDetector 同策略 —— 算法名拼错不该让整次提交失败，
 * 但返回类型是本项目的联合类型而非 string，保证落库与实际传给检测脚本的值一定是脚本认得的那个。
 */
export function normalizeDetector(
  raw: string | undefined,
  fallback = 'content',
): SceneDetect.Detector {
  const value = (raw ?? '').trim().toLowerCase();
  if (isDetector(value)) return value;

  const def = (fallback ?? '').trim().toLowerCase();
  return isDetector(def) ? def : 'content';
}

/**
 * URL 下载允许的 Content-Type 前缀。
 *
 * 含 `application/octet-stream`：不少对象存储/CDN 对 mp4 会上报该通用类型，
 * 只认 `video/` 会把这类合法链接误拒。
 */
export const AI_DETECT_URL_MIME_PREFIXES: readonly string[] = ['video/', 'application/octet-stream'];

/**
 * 任务阶段中文标签。
 *
 * stage 在库里只存 ASCII key，中文映射集中在 Node 侧 —— 与 `subtitleStageLabel` /
 * `digitalHumanStageLabel` 同一策略，便于前端直接展示。
 * 场景切分 / 场景抽帧 / 场景转写三类任务共用这张表：resolve_source / persist / done / failed /
 * cancelled 三类都有，detect 与 black_detect 属场景切分、extract 属抽帧、asr 属转写
 * （转写的逐块「提取音频 + 识别」都归在 asr 这一档，具体在第几块写进 message ——
 * 避免阶段在「提取/识别」之间来回抖动）。
 */
const AI_DETECT_STAGE_LABELS: Record<string, string> = {
  pending: '排队中',
  resolve_source: '解析源视频',
  detect: '场景检测中',
  black_detect: '黑场检测中',
  extract: '抽帧中',
  asr: '语音识别中',
  persist: '保存结果',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** ASCII stage key → 中文描述；未知 key 原样返回，便于排障时发现漏配 */
export function aiDetectStageLabel(stage: string): string {
  return AI_DETECT_STAGE_LABELS[stage] ?? stage;
}
