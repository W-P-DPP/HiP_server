// srt.ts
/** 单个字幕段落（cue） */
export interface SrtCue {
    index: number;
    startMs: number;
    endMs: number;
    text: string;
}

const TIME_RE =
    /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

const timeToMs = (h: number, m: number, s: number, ms: number): number =>
    (h * 3600 + m * 60 + s) * 1000 + ms;

/**
 * 解析标准 SRT 文本 → 结构化 cue 数组。
 * 兼容 parseRaasrSrt（utils/xunfei/raasrHelpers.ts）输出：LF/CRLF、数字索引行、
 * `HH:MM:SS,mmm --> HH:MM:SS,mmm` 时间轴、可多行文本、尾换行。解析失败/无 cue 返回 []。
 */
export function parseSrt(content: string): SrtCue[] {
    const cues: SrtCue[] = [];
    const blocks = content.split(/\r?\n\r?\n/);
    let index = 0;
    for (const rawBlock of blocks) {
        const block = rawBlock.trim();
        if (!block) continue;
        const lines = block.split(/\r?\n/);
        // 首行若是纯数字索引则跳过，从下一行找时间轴（兼容无索引行）
        let timeLineIdx = 0;
        const first = lines[0]?.trim() ?? '';
        if (/^\d+$/.test(first)) timeLineIdx = 1;
        const timeLine = lines[timeLineIdx];
        if (!timeLine) continue;
        const m = timeLine.match(TIME_RE);
        if (!m) continue;
        const text = lines.slice(timeLineIdx + 1).join(' ').trim();
        if (!text) continue;
        index += 1;
        cues.push({
            index,
            startMs: timeToMs(+m[1]!, +m[2]!, +m[3]!, +m[4]!),
            endMs: timeToMs(+m[5]!, +m[6]!, +m[7]!, +m[8]!),
            text,
        });
    }
    return cues;
}

/**
 * cue 文本 → 搜索词：去全角/半角标点与空白、截断 maxLen 字符。
 * 注意：中文关键词在 Pixabay 命中率低，客户端可用 keywords[] 直接传英文词。
 */
export function cleanCueText(text: string, maxLen = 12): string {
    return text.replace(/[\s　\p{P}\p{S}]+/gu, '').slice(0, maxLen)
}
