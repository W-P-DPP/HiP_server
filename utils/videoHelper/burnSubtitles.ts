// burnSubtitles.ts
import fs from 'node:fs'
import path from 'node:path'
import { runFfmpeg } from './ffmpeg.ts'

/**
 * 字幕烧录样式（与同目录 SrtCue / ToVideoResult 一样就近声明）。
 * 全部可选，缺省用本文件的 DEFAULT_* 常量。
 */
export interface BurnSubtitleStyle {
    /** 字号（像素，按视频原始分辨率渲染） */
    fontSize?: number
    /** 字体名 */
    fontName?: string
    /** 文字颜色 #RRGGBB */
    colorHex?: string
    /** 描边宽度 */
    outline?: number
    /** 垂直位置：bottom 底部居中 / top 顶部居中 */
    position?: 'bottom' | 'top'
    /** 距上/下边缘的边距（像素） */
    marginV?: number
}

const DEFAULT_FONT_SIZE = 24
const DEFAULT_FONT_NAME = 'Microsoft YaHei'
const DEFAULT_COLOR_HEX = '#FFFFFF'
const DEFAULT_OUTLINE = 1
const DEFAULT_MARGIN_V_BOTTOM = 24
const DEFAULT_MARGIN_V_TOP = 16

/** 字体名里会破坏 subtitles 滤镜选项解析的字符（逗号/引号/冒号/分号/方括号/反斜杠） */
const FILTER_UNSAFE_CHARS = ",';:[]\\"

/**
 * 路径 → ffmpeg 滤镜参数值转义：反斜杠改正斜杠（subfile 协议不转义正斜杠），
 * 盘符冒号转义为 `\:`（否则被当作滤镜选项分隔符）。与 toVideo 的内联实现同规则。
 */
export function escapeFilterPath(absPath: string): string {
    return path.resolve(absPath).replace(/\\/g, '/').replace(/:/g, '\\:')
}

/** #RRGGBB → ASS 的 PrimaryColour `&H00BBGGRR`；非法输入回落白色 */
function hexToAssPrimary(hexColor?: string): string {
    const raw = (hexColor ?? DEFAULT_COLOR_HEX).trim().replace(/^#/, '')
    if (!/^[0-9a-fA-F]{6}$/.test(raw)) return '&H00FFFFFF'
    const r = raw.slice(0, 2)
    const g = raw.slice(2, 4)
    const b = raw.slice(4, 6)
    return `&H00${b}${g}${r}`.toUpperCase()
}

/** 剔除会截断 force_style 的字符；清洗后为空则回落默认字体 */
function sanitizeFontName(name?: string): string {
    const cleaned = Array.from(name ?? DEFAULT_FONT_NAME)
        .filter(ch => !FILTER_UNSAFE_CHARS.includes(ch))
        .join('')
        .trim()
    return cleaned || DEFAULT_FONT_NAME
}

/** 数值参数收敛到合法区间（字号/描边/边距由调用方或前端传入，不能直接拼进滤镜） */
const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
    const n = Math.round(value ?? fallback)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
}

/**
 * 组装 subtitles 烧录滤镜：SRT + force_style（libass 渲染，纯 CPU）。
 * 样式集中在 force_style 里，避免调用方各自拼滤镜串。
 */
export function buildSubtitleBurnFilter(srtAbs: string, style: BurnSubtitleStyle = {}): string {
    const position = style.position === 'top' ? 'top' : 'bottom'
    const fontSize = clampInt(style.fontSize, DEFAULT_FONT_SIZE, 8, 200)
    const outline = clampInt(style.outline, DEFAULT_OUTLINE, 0, 8)
    const marginV = clampInt(
        style.marginV,
        position === 'top' ? DEFAULT_MARGIN_V_TOP : DEFAULT_MARGIN_V_BOTTOM,
        0,
        4096,
    )
    const alignment = position === 'top' ? 8 : 2

    const forceStyle = [
        `FontName=${sanitizeFontName(style.fontName)}`,
        `Fontsize=${fontSize}`,
        `PrimaryColour=${hexToAssPrimary(style.colorHex)}`,
        `Outline=${outline}`,
        `MarginV=${marginV}`,
        `Alignment=${alignment}`,
    ].join(',')

    return `subtitles=filename='${escapeFilterPath(srtAbs)}':force_style='${forceStyle}'`
}

/**
 * 把 SRT 字幕烧录进已有视频，输出新 mp4（画面带硬字幕，音轨原样拷贝）。
 *
 * 与 toVideo 的区别：toVideo 是「音频 + 字幕 → 视频」，本方法是「视频 + 字幕 → 视频」，
 * 因此作为通用工具单独封装，数字人成片、素材视频等都可复用。
 *
 * @param videoAbs 输入视频绝对路径
 * @param srtAbs 字幕（SRT）绝对路径
 * @param outputAbs 输出 mp4 绝对路径（父目录不存在时自动创建）
 * @param style 可选烧录样式
 */
export const burnSubtitlesIntoVideo = async (
    videoAbs: string,
    srtAbs: string,
    outputAbs: string,
    style: BurnSubtitleStyle = {},
): Promise<void> => {
    if (!fs.existsSync(videoAbs)) {
        throw new Error(`视频文件不存在: ${videoAbs}`)
    }
    if (!fs.existsSync(srtAbs)) {
        throw new Error(`字幕文件不存在: ${srtAbs}`)
    }

    const outputPath = path.resolve(outputAbs)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })

    // 硬件编码由 runFfmpeg 自动接管；含 subtitles= 时 gpu.ts 会跳过 CUDA 解码/缩放（libass 是 CPU）。
    // -crf 只对 libx264 生效：nvenc/qsv/amf 不认这个私有选项（实测只是警告、退出码仍为 0），
    // 此时画质由 gpu.ts 注入的 -b:v 决定 —— 不要为了「消除警告」把 -crf 删掉，CPU 路径需要它。
    await runFfmpeg([
        '-y',
        '-i', path.resolve(videoAbs),
        '-vf', buildSubtitleBurnFilter(srtAbs, style),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath,
    ])
}
