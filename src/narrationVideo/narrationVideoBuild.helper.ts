// src/narrationVideo/narrationVideoBuild.helper.ts
//
// 解说视频的纯函数：入参归一化校验、出画区间解析、画面适配决策、解说字幕时间轴。
//
// 与 dispatcher（真正跑 ffmpeg / 提交配音子任务的地方）分开，是为了让这几条最容易出错、
// 又最值得写死测试的规则脱离 Mongo / ffmpeg 单测（见 __tests__/unit/narrationVideoBuild.test.ts）。
import type { SrtCue } from '../../utils/videoHelper/srt.ts';
import type { INarrationClip, INarrationSegment } from './narrationVideoTask.entity.ts';
import {
  NARRATION_VIDEO_HEIGHT,
  NARRATION_VIDEO_MAX_CLIPS_PER_SEGMENT,
  NARRATION_VIDEO_MAX_SEGMENTS,
  NARRATION_VIDEO_SUBTITLE_CHARS,
  NARRATION_VIDEO_SUBTITLE_MIN_CHARS,
  NARRATION_VIDEO_WIDTH,
  type NarrationSubtitleMaskMode,
} from '../../utils/constant/narrationVideo.ts';

/** 归一化结果：成功给出分段快照，失败给出一句面向用户的中文错误 */
export type NormalizeNarrationResult =
  | { segments: INarrationSegment[]; title: string; summary: string }
  | { error: string };

/** 出画区间（毫秒，左闭右开） */
export interface ClipRange {
  startMs: number;
  endMs: number;
}

/** 画面适配决策：trim 裁掉多余 / loop 循环补齐 / exact 已经匹配 */
export type FootageFit = 'trim' | 'loop' | 'exact';

/** 画面适配的容差（ms，约一帧 @30fps）：避免取整误差让本可原样保留的画面被误裁/误循环 */
const FOOTAGE_FIT_TOLERANCE_MS = 34;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 松散数值 → 毫秒整数；非数字/非有限/空白字符串一律 null */
const toMs = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
};

/**
 * 归一化并校验前端提交的解说结构化数据。
 *
 * 规则：
 * - `segments` 非空且不超过 NARRATION_VIDEO_MAX_SEGMENTS；每段 `0 ≤ start < end`，`text` 非空且 ≤ maxTextChars；
 * - 时间段/clip 端点会 clamp 到源视频时长（sourceDurationMs > 0 时）；完全越界的分段报错、完全越界的 clip 丢弃；
 * - clip 按 start 升序排序，仅保留 clamp 后长度 > 0 的项；某段 clips 为空表示执行期回退用整段区间；
 * - `emotion` 仅记录（缺省空串）。
 */
export function normalizeNarration(
  raw: unknown,
  sourceDurationMs: number,
  maxTextChars: number,
): NormalizeNarrationResult {
  if (!isRecord(raw)) return { error: '解说数据格式不正确' };

  const rawSegments = raw.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return { error: '解说分段不能为空' };
  }
  if (rawSegments.length > NARRATION_VIDEO_MAX_SEGMENTS) {
    return { error: `解说分段数不能超过 ${NARRATION_VIDEO_MAX_SEGMENTS}` };
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  const sourceEnd = sourceDurationMs > 0 ? sourceDurationMs : Number.POSITIVE_INFINITY;

  const segments: INarrationSegment[] = [];

  for (let i = 0; i < rawSegments.length; i += 1) {
    const item = rawSegments[i];
    const at = `第 ${i + 1} 段`;
    if (!isRecord(item)) return { error: `${at}格式不正确` };

    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) return { error: `${at}解说文案不能为空` };
    if (text.length > maxTextChars) {
      return { error: `${at}解说文案长度不能超过 ${maxTextChars} 字（当前 ${text.length} 字）` };
    }

    const startMs = toMs(item.start);
    const endMs = toMs(item.end);
    if (startMs === null || endMs === null || startMs < 0 || endMs <= startMs) {
      return { error: `${at}时间区间非法（需 0 ≤ start < end）` };
    }

    const clampedStart = startMs;
    const clampedEnd = Math.min(endMs, sourceEnd);
    if (clampedEnd <= clampedStart) {
      return { error: `${at}时间区间超出源视频时长` };
    }

    const clipsResult = normalizeClips(item.clips, sourceEnd, at);
    if ('error' in clipsResult) return { error: clipsResult.error };

    segments.push({
      index: i + 1,
      startMs: clampedStart,
      endMs: clampedEnd,
      text,
      emotion: typeof item.emotion === 'string' ? item.emotion.trim() : '',
      clips: clipsResult.clips,
    });
  }

  return { segments, title, summary };
}

/** 归一化某段的 clips：非法端点/超量报错，越界片段丢弃，按 start 升序 */
function normalizeClips(
  rawClips: unknown,
  sourceEnd: number,
  at: string,
): { clips: INarrationClip[] } | { error: string } {
  if (rawClips === undefined || rawClips === null) return { clips: [] };
  if (!Array.isArray(rawClips)) return { error: `${at}clips 格式不正确` };
  if (rawClips.length > NARRATION_VIDEO_MAX_CLIPS_PER_SEGMENT) {
    return { error: `${at}clip 数量不能超过 ${NARRATION_VIDEO_MAX_CLIPS_PER_SEGMENT}` };
  }

  const built: INarrationClip[] = [];
  for (let j = 0; j < rawClips.length; j += 1) {
    const clip = rawClips[j];
    if (!isRecord(clip)) return { error: `${at}第 ${j + 1} 个 clip 格式不正确` };

    const startMs = toMs(clip.start);
    const endMs = toMs(clip.end);
    if (startMs === null || endMs === null || startMs < 0 || endMs <= startMs) {
      return { error: `${at}第 ${j + 1} 个 clip 时间区间非法（需 0 ≤ start < end）` };
    }

    const end = Math.min(endMs, sourceEnd);
    if (end <= startMs) continue; // 完全越界 → 丢弃
    built.push({
      startMs,
      endMs: end,
      description: typeof clip.description === 'string' ? clip.description.trim() : '',
    });
  }

  built.sort((a, b) => a.startMs - b.startMs);
  return { clips: built };
}

/**
 * 解析某段细节段实际要出画的区间（毫秒，左闭右开）：取**时长最短**的一段 clip（并列时取起点最早）；
 * 无 clips 时回退用整段 `[startMs, endMs]`。
 */
export function resolveDetailClip(segment: INarrationSegment): ClipRange {
  if (segment.clips.length === 0) {
    return { startMs: segment.startMs, endMs: segment.endMs };
  }

  let best = segment.clips[0]!;
  let bestDur = best.endMs - best.startMs;
  for (let i = 1; i < segment.clips.length; i += 1) {
    const clip = segment.clips[i]!;
    const dur = clip.endMs - clip.startMs;
    if (dur < bestDur || (dur === bestDur && clip.startMs < best.startMs)) {
      best = clip;
      bestDur = dur;
    }
  }
  return { startMs: best.startMs, endMs: best.endMs };
}

/**
 * 画面适配解说的决策。
 *
 * 以解说音频时长 targetMs 为准：画面比它长出一帧以上 → trim；短一帧以上 → loop；
 * 落在 ±容差内 → exact（原样保留，避免无谓重编码）。
 */
export function decideFootageFit(
  footageMs: number,
  targetMs: number,
  toleranceMs: number = FOOTAGE_FIT_TOLERANCE_MS,
): FootageFit {
  if (footageMs > targetMs + toleranceMs) return 'trim';
  if (footageMs < targetMs - toleranceMs) return 'loop';
  return 'exact';
}

/** 字幕遮罩参数（成片 1280x720 坐标）：enabled 才生成；几何会 clamp 到成片范围内 */
export interface SubtitleMaskOptions {
  enabled: boolean;
  mode: NarrationSubtitleMaskMode;
  x: number;
  y: number;
  w: number;
  h: number;
  /** blur 模式下的模糊半径（像素）；缺省 12 */
  blurStrength?: number;
}

/** 数值收敛到 [min, max] 的整数；非有限回落 min */
const clampTo = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
};

/**
 * 生成「源视频烧死字幕区域模糊/遮罩」的 ffmpeg 滤镜片段（成片 1280x720 坐标）。
 *
 * - blur：`split` 出背景与前景，前景裁出遮罩区做 `boxblur` 再 `overlay` 回原位（区域模糊、保留画面）；
 * - box：`drawbox` 纯色块填充（最稳的单滤镜）；
 * - `enabled=false` 或几何宽/高收敛后 ≤ 0 时返回空串，调用方据此决定是否追加到归一化链之后。
 *
 * 返回片段可能含 `;` 与标签（filtergraph），需以逗号追加在归一化链末尾。
 */
export function buildSubtitleMaskFilter(options: SubtitleMaskOptions): string {
  if (!options.enabled) return '';

  const x = clampTo(options.x, 0, NARRATION_VIDEO_WIDTH - 1);
  const y = clampTo(options.y, 0, NARRATION_VIDEO_HEIGHT - 1);
  const w = clampTo(options.w, 0, NARRATION_VIDEO_WIDTH - x);
  const h = clampTo(options.h, 0, NARRATION_VIDEO_HEIGHT - y);
  if (w <= 0 || h <= 0) return '';

  if (options.mode === 'box') {
    return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0.85:t=fill`;
  }

  // boxblur 半径不得超过遮罩区短边的一半，否则滤镜直接报错
  const maxRadius = Math.max(1, Math.floor(Math.min(w, h) / 2));
  const radius = clampTo(options.blurStrength ?? 12, 1, maxRadius);
  return (
    'split=2[nvmask_bg][nvmask_fg];' +
    `[nvmask_fg]crop=${w}:${h}:${x}:${y},boxblur=luma_radius=${radius}:luma_power=2[nvmask_bl];` +
    `[nvmask_bg][nvmask_bl]overlay=${x}:${y}`
  );
}

/** 句末标点（保留在行尾）：中文与常见英文标点 */
const SENTENCE_DELIM = /(?<=[，。！？；：、…,.!?;:])/u;

/**
 * 解说文本 → 字幕行（按标点断句，再合并到约 maxChars 字/行）。
 *
 * 超长句硬切为 maxChars 的块；若末行短于 minChars 且有上一行，则把末行并入上一行，
 * 避免出现只闪一下的碎片字幕。
 */
export function splitTextIntoLines(
  text: string,
  maxChars: number = NARRATION_VIDEO_SUBTITLE_CHARS,
  minChars: number = NARRATION_VIDEO_SUBTITLE_MIN_CHARS,
): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const width = Math.max(1, Math.round(maxChars));

  const sentences = cleaned.split(SENTENCE_DELIM).map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current) {
      lines.push(current);
      current = '';
    }
  };

  for (const sentence of sentences) {
    for (let i = 0; i < sentence.length; i += width) {
      const part = sentence.slice(i, i + width);
      if (!current) current = part;
      else if (current.length + part.length <= width) current += part;
      else {
        flush();
        current = part;
      }
    }
  }
  flush();

  if (lines.length >= 2) {
    const last = lines[lines.length - 1];
    const prevIdx = lines.length - 2;
    const prev = lines[prevIdx];
    if (last !== undefined && prev !== undefined && last.length < minChars) {
      lines.pop();
      lines[prevIdx] = prev + last;
    }
  }
  return lines;
}

/** buildSegmentCues 的字幕切分布局参数（缺省用常量默认值） */
export interface BuildCuesOptions {
  maxChars?: number;
  minChars?: number;
}

/**
 * 生成某段的字幕 cue（相对成片全局时间轴）。
 *
 * 段内按「各行字数占比」把 durationMs 分配给各行，末行吸附到 `offsetMs + durationMs`，
 * 保证每段的字幕恰好铺满该段时长、且与下一段无缝衔接。段文本为空/时长为 0 时返回空数组。
 * 返回 cue 的 index 是段内序号，最终 SRT 的全局序号由 renderSrt 重新编排。
 */
export function buildSegmentCues(
  text: string,
  offsetMs: number,
  durationMs: number,
  options: BuildCuesOptions = {},
): SrtCue[] {
  const lines = splitTextIntoLines(
    text,
    options.maxChars ?? NARRATION_VIDEO_SUBTITLE_CHARS,
    options.minChars ?? NARRATION_VIDEO_SUBTITLE_MIN_CHARS,
  );
  if (lines.length === 0 || durationMs <= 0) return [];

  const totalChars = lines.reduce((sum, line) => sum + line.length, 0);
  const end = Math.round(offsetMs + durationMs);
  const cues: SrtCue[] = [];
  let acc = Math.round(offsetMs);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const isLast = i === lines.length - 1;
    const startMs = acc;
    let lineEnd: number;
    if (isLast) {
      lineEnd = Math.max(startMs, end);
    } else {
      const share =
        totalChars > 0
          ? Math.round((durationMs * line.length) / totalChars)
          : Math.round(durationMs / lines.length);
      lineEnd = Math.min(end, startMs + Math.max(1, share));
    }
    acc = lineEnd;
    cues.push({ index: i + 1, startMs, endMs: lineEnd, text: line });
  }

  return cues;
}

/** 毫秒 → SRT 时间戳 `HH:MM:SS,mmm` */
export function formatSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const tail = total % 1000;
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(tail, 3)}`;
}

/** cue 数组 → 标准 SRT 文本（全局连续编号）；无 cue 返回空串 */
export function renderSrt(cues: SrtCue[]): string {
  if (cues.length === 0) return '';
  return (
    cues
      .map((cue, i) => `${i + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}`)
      .join('\n\n') + '\n'
  );
}
