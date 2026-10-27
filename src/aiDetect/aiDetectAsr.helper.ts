// src/aiDetect/aiDetectAsr.helper.ts
//
// 转写口径的纯函数：切块规划、块内时间 → 全局时间的偏移、以及把文本段按场景区间归并。
//
// 与 dispatcher（真正跑 ffmpeg / 提交字幕子任务的地方）分开，是为了让这三条最容易出错、
// 又最值得写死测试的规则可以脱离 Mongo / ffmpeg / Whisper 单测
// （见 __tests__/unit/aiDetectAsr.test.ts）。
import type { IAiDetectScene } from './aiDetectTask.entity.ts';
import type {
  IAiDetectAsrSceneSegments,
  IAiDetectAsrSegment,
} from './aiDetectAsrTask.entity.ts';
import type { SrtCue } from '../../utils/videoHelper/srt.ts';

/** 一个音频块的区间（源视频全局毫秒，左闭右开） */
export interface AsrChunkPlan {
  /** 块序号，从 1 开始 */
  index: number;
  /** 区间起点（ms，含） */
  startMs: number;
  /** 区间终点（ms，不含） */
  endMs: number;
}

/**
 * 把源视频时长按固定时长切成若干块。
 *
 * 为什么要切：subtitle 链路对音频卡 `ASR_MAX_AUDIO_BYTES`（默认 50MB），而 16k 单声道 wav
 * 每秒 32KB ⇒ 约 26 分钟就到顶。短片切成一块（等于不切），长片按块送去转写。
 *
 * 规则：
 * - 区间左闭右开、无缝覆盖 `[0, durationMs)`，最后一块截断到 durationMs；
 * - 时长为 0 / 非法（NaN、负数）时返回单块 `[0, 0)` —— 让调用方走一次正常流程，
 *   由「抽不出音频」给出明确错误，而不是在这里造出一个空数组让上层多做一次分支判断。
 */
export function planAsrChunks(durationMs: number, chunkMs: number): AsrChunkPlan[] {
  const total = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
  const size = Number.isFinite(chunkMs) && chunkMs > 0 ? Math.round(chunkMs) : total || 1;

  if (total === 0) return [{ index: 1, startMs: 0, endMs: 0 }];

  const chunks: AsrChunkPlan[] = [];
  for (let startMs = 0; startMs < total; startMs += size) {
    chunks.push({
      index: chunks.length + 1,
      startMs,
      endMs: Math.min(startMs + size, total),
    });
  }
  return chunks;
}

/**
 * 块内相对时间 → 源视频全局时间。
 *
 * Whisper 返回的 SRT 时间戳是**相对于送进去的那个音频文件**的，而每块音频都是从源视频某个
 * 起点裁出来的，故必须加上块起点才能得到全局时间 —— 这是整条链路唯一一处容易整体偏移的地方。
 */
export function offsetCues(cues: SrtCue[], offsetMs: number): IAiDetectAsrSegment[] {
  const offset = Number.isFinite(offsetMs) ? Math.round(offsetMs) : 0;
  return cues.map((cue) => ({
    startMs: cue.startMs + offset,
    endMs: cue.endMs + offset,
    text: cue.text,
  }));
}

/**
 * 把全局文本段按场景区间归并。
 *
 * 规则：
 * - 一个文本段**起点**落在哪个场景，就整条归入该场景（区间左闭右开）。
 *   刻意**不拆句**：跨场景边界的那一句宁可整条留给它起头的场景，也不切成两半 ——
 *   半句话对后续的语义理解（生成解说词）没有价值，而且会让两个场景都拿到残句。
 * - 每个场景都会出现在结果里（保持 scenes 的顺序与数量），没有说话的场景是空数组 ——
 *   这不是异常，是「该场景无语音」的正常表达。
 * - 起点落在所有场景之外（理论不会：scenes 无缝覆盖整段视频）→ 归入最近的场景（防御）。
 */
export function groupCuesByScene(
  scenes: IAiDetectScene[],
  segments: IAiDetectAsrSegment[],
): IAiDetectAsrSceneSegments[] {
  const grouped: IAiDetectAsrSceneSegments[] = scenes.map((scene) => ({
    index: scene.index,
    startMs: scene.startMs,
    endMs: scene.endMs,
    segments: [],
  }));

  if (grouped.length === 0) return grouped;

  /** 场景按起点升序（上游 PySceneDetect 就是这么给的，这里不假设，自己排一遍） */
  const ordered = [...grouped].sort((a, b) => a.startMs - b.startMs);

  for (const segment of segments) {
    // 找第一个包含该段起点的场景
    let target = ordered.find(
      (scene) => segment.startMs >= scene.startMs && segment.startMs < scene.endMs,
    );

    if (!target) {
      // 兜底：起点落在所有区间之外 → 归入时间上最近的场景（startMs 早于首场景，或晚于末场景）
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      if (!first || !last) continue;
      target =
        segment.startMs < first.startMs
          ? first
          : segment.startMs >= last.endMs
            ? last
            : // 落在场景之间的空隙（cues 无缝时不该出现）→ 取前一个场景
              ([...ordered].reverse().find((scene) => scene.endMs <= segment.startMs) ?? first);
    }

    target.segments.push(segment);
  }

  // 每个场景内部按时间升序（碎片化识别结果可能乱序回来）
  for (const scene of grouped) {
    scene.segments.sort((a, b) => a.startMs - b.startMs);
  }

  return grouped;
}

/** 转写音频块在 file 表里的对外文件名：`<源视频词干>-chunk003.wav` */
export function resolveChunkFileName(sourceStem: string, chunkIndex: number): string {
  const stem = sourceStem.trim() || 'audio';
  const seq = String(Math.max(1, Math.trunc(chunkIndex))).padStart(3, '0');
  return `${stem}-chunk${seq}.wav`;
}
