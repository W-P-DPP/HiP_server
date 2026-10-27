// src/aiDetect/aiDetectFrame.helper.ts
//
// 抽帧口径的纯函数：场景区间 + 源视频帧率 → 三个抽帧时间点，以及帧图片的文件名。
//
// 与 dispatcher（真正 spawn ffmpeg 的地方）分开，是为了让「抽哪三个时间点」这条最容易出错、
// 又最值得写死测试的规则可以脱离 Mongo / ffmpeg 单测（见 __tests__/unit/aiDetectFrame.test.ts）。
import path from 'node:path';
import { sanitizeFileName } from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import type { AiDetectFrameKind } from './aiDetectFrameTask.entity.ts';

/** 帧率未知（0 / NaN）时的兜底帧间隔（ms），按 25fps 计 */
const FALLBACK_FRAME_STEP_MS = 40;

/** 帧位优先级：时间点重合时保留靠前的那个，同时让结果里 start → mid → end 稳定有序 */
const FRAME_KIND_ORDER: readonly AiDetectFrameKind[] = ['start', 'mid', 'end'];

/** 单个抽帧时间点 */
export interface SceneFrameTime {
  /** 帧位 */
  kind: AiDetectFrameKind;
  /** 抽帧时间点（ms） */
  timeMs: number;
}

/**
 * 把场景区间换算成抽帧时间点：开始帧 / 中间帧 / 结束帧。
 *
 * 三条规则：
 * - **开始帧** = startMs（场景第一帧）。
 * - **中间帧** = startMs + span/2（向下取整）——场景的中点画面。
 * - **结束帧** = endMs − **两帧**的时长（见下方「为什么留两帧」）。
 *
 * ## 为什么结束帧要回退，且要留两帧
 *
 * 区间是左闭右开的：endMs 已经属于下一个场景，直接按 endMs 抽，会抽出下一个镜头的第一帧
 * （相邻两个场景各得一张一模一样的图）。但「只回退一帧」在实测中**不够** —— ffmpeg 的 `-ss`
 * 定位规则是「取第一个 pts ≥ T 的帧」，而帧的真实 pts 是 N/fps（30fps 下是 33.333ms 的倍数，
 * 不落在整毫秒上）：
 *
 * ```
 * 场景 [500, 1500) @30fps，帧 44 的 pts = 1466.667ms、帧 45 的 pts = 1500ms
 * 回退一帧：T = 1500 − 33 = 1467ms > 1466.667 → 取到帧 45 = 下一个场景的首帧 ❌
 * 回退两帧：T = 1500 − 66 = 1434ms          → 取到帧 44 = 本场景末帧     ✅
 * ```
 *
 * 于是留出整整一帧的余量：毫秒取整（以及 PySceneDetect 上报边界时的 ±1ms 取整）再也推不过边界。
 * 代价是「结束帧」实际比边界早 2 帧（30fps 下 66ms），视觉上无从分辨。
 *
 * 时间点重合会被合并（保留靠前的帧位）：极短场景（span 小于两帧、或中间帧与结束帧撞在一起）
 * 因此可能只产出 1~2 张，而不是硬凑三张内容重复的图。
 *
 * 区间以 startMs/endMs 为准，传入的 durationMs 不参与计算 —— 它是 (endMs − startMs) 的冗余记录，
 * 万一两者不一致，宁可让抽帧跟着区间走，也不能让某张帧落到场景之外。
 */
export function resolveSceneFrameTimes(
  scene: { startMs: number; endMs: number; durationMs: number },
  frameRate: number,
): SceneFrameTime[] {
  const startMs = Number.isFinite(scene.startMs) ? Math.max(0, Math.round(scene.startMs)) : 0;
  const endMs = Number.isFinite(scene.endMs) ? Math.max(startMs, Math.round(scene.endMs)) : startMs;

  // 非法帧率（0/负数/NaN）一律走兜底：抽帧不该因为一次 ffprobe 探测失败就整体失败
  const stepMs = frameRate > 0 ? Math.max(1, Math.round(1000 / frameRate)) : FALLBACK_FRAME_STEP_MS;

  const candidates: SceneFrameTime[] = [
    { kind: 'start', timeMs: startMs },
    { kind: 'mid', timeMs: startMs + Math.floor((endMs - startMs) / 2) },
    // 回退两帧（而非一帧）留出取整余量，理由见上方文档注释
    { kind: 'end', timeMs: Math.max(startMs, endMs - 2 * stepMs) },
  ];

  // 先按时间升序排序（时间相同则按帧位优先级），使去重只需比较相邻元素
  const sorted = candidates.sort(
    (a, b) =>
      a.timeMs - b.timeMs ||
      FRAME_KIND_ORDER.indexOf(a.kind) - FRAME_KIND_ORDER.indexOf(b.kind),
  );

  return sorted.filter((frame, index) => index === 0 || frame.timeMs !== sorted[index - 1]?.timeMs);
}

/** 从原始文件名取词干（去掉目录与扩展名），用作帧文件名的前缀 */
export function resolveSourceStem(originalName: string): string {
  const base = path.basename((originalName ?? '').trim());
  return path.basename(base, path.extname(base));
}

/**
 * 帧图片的对外文件名：`<源视频词干>-s003-mid.jpg`。
 *
 * 场景序号补零到 3 位，使同一批产物在按文件名排序时与场景顺序一致（也便于人眼核对）。
 * 传入的 sourceStem 应已由 resolveSourceStem 去掉扩展名（这里不再剥离一次，否则 `my.video.mp4`
 * 的词干 `my.video` 会被二次截断成 `my`）；只做字符清洗 —— 它会被下载接口用作
 * Content-Disposition 的文件名。
 */
export function resolveFrameFileName(
  sourceStem: string,
  sceneIndex: number,
  kind: AiDetectFrameKind,
): string {
  const stem = sanitizeFileName(sourceStem, 'video');
  const seq = String(Math.max(0, Math.trunc(sceneIndex))).padStart(3, '0');
  return `${stem}-s${seq}-${kind}.jpg`;
}
