// segDurations.ts
// 背景视频分段时长计算（纯函数，无副作用，便于单测）。
// 背景轨由每个字幕段（cue）逐段编码后 concat 拼接；若每段只取自身 cue 时长，
// 句与句之间的空隙不会被任何段覆盖，多段空隙累计会让背景轨总长短于音频，
// 进而被 toVideo 的 -shortest 以背景轨为最短流截断视频尾部、丢失最后几段字幕。
import type { SrtCue } from './srt.ts'

/**
 * 各段背景时长（毫秒）。
 * 非末段覆盖到下一段字幕开始（含句间空隙），保证背景轨随字幕时间线连续推进、
 * 空隙不丢失；下一段起点早于本段结束（cue 重叠）时取本段自身时长，避免负向压缩。
 * 末段返回其自身 cue 时长，由 computeLastSegDurationMs 按音频总长补齐。
 */
export const computeSegDurationsMs = (cues: SrtCue[]): number[] =>
    cues.map((c, i) => {
        const next = cues[i + 1];
        if (!next) return c.endMs - c.startMs;
        return Math.max(c.endMs - c.startMs, next.startMs - c.startMs);
    });

/**
 * 背景轨末段时长（毫秒）：让背景总长 = 音频总长 + 缓冲（默认 0.2s）。
 * 前序各段实际时长之和 + 末段 = audioDurationMs + bufferMs，即使句间空隙累计
 * （含首段前导静音），背景轨也恒不短于音频，杜绝 -shortest 截断尾部字幕。
 * 防御：字幕时间轴超过音频（前序已超长）时取末段自身时长，保证不小于其 cue 时长。
 *
 * @param segDursMs computeSegDurationsMs 的结果
 * @param audioDurationMs 音频总时长（毫秒）
 * @param bufferMs 尾部缓冲（毫秒），默认 200（防 -shortest 帧对齐截断音频尾巴）
 */
export const computeLastSegDurationMs = (
    segDursMs: number[],
    audioDurationMs: number,
    bufferMs = 200,
): number => {
    const base = segDursMs[segDursMs.length - 1] ?? 0;
    const sumPrev = segDursMs.slice(0, -1).reduce((s, d) => s + d, 0);
    return Math.max(base, audioDurationMs + bufferMs - sumPrev);
};
