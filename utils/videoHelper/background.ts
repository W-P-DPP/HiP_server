// background.ts
import fs from 'node:fs'
import path from 'node:path'
import { runFfmpeg } from './ffmpeg.ts'
import type { SrtCue } from './srt.ts'
import { cleanCueText } from './srt.ts'
import { resolveClipForKeyword, type ResolvedClip } from './materialLibrary.ts'
import { clipInputArgs, clipMediaKind } from './mediaKind.ts'
import { computeSegDurationsMs, computeLastSegDurationMs } from './segDurations.ts'
import { MaterialConstants } from '../constant/MaterialConstants.ts'

/** 背景轨构建入参 */
export interface BuildBackgroundOptions {
    /** 字幕段落（SRT cue） */
    cues: SrtCue[];
    /** 音频总时长（毫秒），用于最后一段补齐 */
    audioDurationMs: number;
    /** 可选：每段背景素材搜索词，按 cue 下标对应；缺省用 cue 文本清洗截断 */
    keywords?: string[];
    /** 可选：无素材段落回退的纯色背景（默认 black） */
    color?: string;
    /** 可选：素材归属用户 id（缺省/空 → 仅公共池；传入 → 先自有再公共） */
    userId?: string;
    /** 临时工作目录（调用方负责 mkdir + 事后清理） */
    workDir: string;
}

/** 背景色规整：色名透传，#RRGGBB → 0xRRGGBB（ffmpeg lavfi color 解析），非法输入回落 black */
const sanitizeColor = (color?: string): string => {
    if (!color) return 'black';
    const t = color.trim();
    if (!/^[#0-9a-zA-Z]+$/.test(t)) return 'black';
    return t.startsWith('#') ? `0x${t.slice(1)}` : t;
};

/** 并发受限 map（内联实现；独立于 utils/AsyncQueue.ts 的 FIFO 队列） */
const mapLimit = async <T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const i = next;
            next += 1;
            results[i] = await fn(items[i]!, i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
};

/**
 * 单个字幕段生成参数：真实素材或纯色兜底。
 * 真实素材的循环参数由 mediaKind 决定（图片 `-loop 1` / 视频 `-stream_loop -1`，见该文件注释），
 * 一律撑满本段时长。统一 1280x720@30fps yuv420p + 相同 preset，保证 concat 可 -c copy 安全拼接。
 * 注：color 源默认 25fps，必须同样 -r 30 才与真实段一致。
 */
const makeSegArgs = (durSec: number, inputArgs: string[], outputPath: string): string[] => [
    '-y',
    ...inputArgs,
    '-t', durSec.toFixed(3),
    '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,setpts=PTS-STARTPTS',
    '-r', '30',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-an',
    outputPath,
];

/**
 * 按字幕段落构建背景视频轨（1280x720@30fps）：逐段归一化 + concat 拼接。
 * 每个 cue 匹配一个素材片段（keywords 优先，否则 cue 文本清洗）；素材可能是 Pixabay 视频，
 * 也可能是用户自有池里的图片，按 MIME 分别用 -stream_loop -1 / -loop 1 撑满本段时长，
 * 段长覆盖到下一段字幕开始（含句间空隙），末段补齐到音频总长 + 0.2s 缓冲，
 * 保证背景轨总长恒 ≥ 音频，避免空隙累计造成 -shortest 截断视频尾部字幕。
 * 无 PIXABAY_API_KEY / 无 cues / 全部回退纯色 → null（调用方走纯色背景）。
 * 单段搜索/下载/编码失败只回退该段纯色，不中断整体。
 */
export async function buildBackgroundTrack(
    opts: BuildBackgroundOptions,
): Promise<{ bgPath: string } | null> {
    const { cues, audioDurationMs, keywords, color, workDir, userId } = opts;
    if (!MaterialConstants.PIXABAY_API_KEY.trim() || cues.length === 0) return null;

    const bgPath = path.join(workDir, 'bg.mp4');
    // keyword → clip | null（同词多段共用素材，压 Pixabay 请求量）
    const cached = new Map<string, ResolvedClip | null>();
    let usedClip = false;

    // 各段时长（毫秒）：非末段覆盖到下一段字幕开始（含句间空隙），末段按音频总长补齐，
    // 保证背景轨总长 = 音频总长 + 缓冲，杜绝空隙累计导致 -shortest 截断尾部字幕。
    const segDursMs = computeSegDurationsMs(cues);

    const segPaths = await mapLimit(cues, 3, async (cue, i) => {
        const keyword = keywords?.[i] ?? cleanCueText(cue.text);
        let clip = cached.get(keyword);
        if (clip === undefined) {
            clip = await resolveClipForKeyword(keyword, userId);
            cached.set(keyword, clip);
        }

        const durSec = i === cues.length - 1
            ? computeLastSegDurationMs(segDursMs, audioDurationMs) / 1000
            : segDursMs[i]! / 1000;

        const segPath = path.join(workDir, `seg_${i}.mp4`);
        if (clip) {
            try {
                // 图片与视频的循环参数不同，按素材 MIME 分支（用错会把 ffmpeg 卡死，见 mediaKind.ts）
                await runFfmpeg(makeSegArgs(durSec, clipInputArgs(clipMediaKind(clip.mimeType), clip.path), segPath));
                usedClip = true;
                return segPath;
            } catch (err) {
                // 该段编码失败 → 回退纯色段
            }
        }
        await runFfmpeg(makeSegArgs(durSec, ['-f', 'lavfi', '-i', `color=c=${sanitizeColor(color)}:s=1280x720`], segPath));
        return segPath;
    });

    if (!usedClip) return null;

    // concat demuxer：LF 结尾，路径 \ → / + 单引号包裹（UUID 路径不含 '），-safe 0 放行绝对路径
    const listPath = path.join(workDir, 'list.txt');
    const lines = segPaths.map((p) => `file '${path.resolve(p).replace(/\\/g, '/')}'`);
    fs.writeFileSync(listPath, `${lines.join('\n')}\n`, 'utf8');

    await runFfmpeg(['-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', bgPath]);
    return { bgPath };
}
