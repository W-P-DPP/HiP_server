// utils/videoHelper/blackDetect.ts —— ffmpeg blackdetect：视频的首/尾黑场区间
//
// 为什么用 ffmpeg 而不是 PySceneDetect：0.6.6 没有黑帧检测器（只有按亮度阈值的 fade 切点，
// 且它输出的是「切点」而不是「黑场区间」），自己写自定义检测器还得改 Python 侧契约与每台机器的 venv。
// blackdetect 是 ffmpeg 自带的滤镜，零新依赖，且只解首/尾两段窗口 —— 代价与全片无关。
//
// 用法要点（实测 ffmpeg 6.x）：
// - `black_start/black_end/black_duration` 是 **INFO 级日志**，写到 stderr，故绝不能用 -loglevel error；
//   日志行还可能被 \r 进度条「粘」在同一行上，所以解析必须全行正则搜索，不能从行首匹配。
// - black_end 是**最后一个黑帧的 pts**，不是黑场真实结束时刻：结尾黑场会比视频总长少一帧左右
//   （25fps 下 9.000s 的视频报 8.96），黑场一直延伸到扫描窗口末端时同样只报到窗口末帧。
//   这是可接受的近似：判定「贴边」有 BLACK_BOUNDARY_TOLERANCE_MS 容差兜底。
// - 输入定位（-ss 在 -i 之前）会让输出时间轴从 0 起，故报出的时间是**相对窗口起点的**，
//   解析时按 offsetMs 补回源视频全局时间。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BLACK_DETECT_TIMEOUT_MS, BLACK_EDGE_SNAP_MS } from '../constant/video.ts'
import type { SceneDetect } from '../../type/index.d.ts'

/** 调用方要提供的参数：扫哪两段窗口 + 判黑阈值 */
export interface BlackDetectOptions {
    /** 首、尾各扫描的窗口时长（ms）；<=0 视为不检测（返回空数组） */
    windowMs: number
    /** 视频总时长（ms），用于定位尾窗口起点；<=0 时退化为只扫一次头部窗口 */
    durationMs: number
    /** 黑场最短时长（秒，ffmpeg 的 d=）：短于此长度的暗帧不算黑场 */
    minDurationSec: number
    /** 整帧判黑所需的「判黑像素」比例下限（pic_th=，0..1） */
    picThreshold: number
    /** 单像素判黑的亮度阈值，相对满量程（pix_th=，0..1） */
    pixThreshold: number
    /** 子进程超时（ms），缺省 BLACK_DETECT_TIMEOUT_MS */
    timeoutMs?: number
}

/** 一段黑场的 stderr 行；black_end / black_duration 在极端情况下可能缺失，故都当可选 */
const START_RE = /black_start:\s*([0-9]+(?:\.[0-9]+)?)/
const END_RE = /black_end:\s*([0-9]+(?:\.[0-9]+)?)/
const DURATION_RE = /black_duration:\s*([0-9]+(?:\.[0-9]+)?)/

/** 按正则取秒 → 毫秒（取整）；不匹配或非有限值返回 undefined */
const matchMs = (re: RegExp, line: string): number | undefined => {
    const raw = re.exec(line)?.[1]
    if (raw === undefined) return undefined
    const sec = Number.parseFloat(raw)
    return Number.isFinite(sec) ? Math.round(sec * 1000) : undefined
}

/**
 * 解析 blackdetect 的 stderr（纯函数，便于单测）。
 *
 * offsetMs：本次扫描的起点（输入定位让报出的时间相对它，这里补回全局时间）。
 * openEndMs：本次扫描的绝对末端（头部窗口=窗口末端，尾部窗口=视频总长，整片扫描=总长）。
 * 两个用途：连 black_end 都没报出来的旧版本兜底，以及把「贴到边界」的末端吸附到边界本身
 * （black_end 是末个黑帧的 pts，天然比边界小不到一帧；不吸附就会切出几十毫秒的碎片场景）。
 *
 * 重叠/相接的区间会被合并：同一段黑场若被记成两行（先报 start、再报 end），合并后才是它的真实范围。
 */
export const parseBlackDetectRanges = (
    stderr: string,
    offsetMs: number,
    openEndMs: number,
    snapMs: number = BLACK_EDGE_SNAP_MS,
): SceneDetect.BlackRange[] => {
    const ranges: SceneDetect.BlackRange[] = []

    for (const line of stderr.split(/\r?\n/)) {
        const startRelative = matchMs(START_RE, line)
        if (startRelative === undefined) continue

        const endRelative = matchMs(END_RE, line)
        const durationRelative = matchMs(DURATION_RE, line)
        const end = endRelative ?? (durationRelative !== undefined ? startRelative + durationRelative : undefined)

        const startMs = Math.max(0, offsetMs + startRelative)
        // 没报末端（旧版本在 EOF 处可能只报 start）→ 直接收口到边界；报了但贴着边界 → 吸附到边界
        const rawEndMs = Math.max(startMs, offsetMs + (end ?? Math.max(0, openEndMs - offsetMs)))
        const endMs =
            openEndMs > startMs && openEndMs - rawEndMs <= Math.max(0, snapMs) ? openEndMs : rawEndMs

        // 零长度黑场没有意义（也不该出现在结果里）
        if (endMs <= startMs) continue

        ranges.push({ startMs, endMs, durationMs: endMs - startMs })
    }

    ranges.sort((a, b) => a.startMs - b.startMs)

    // 合并重叠/相接的区间（同一段黑场被拆成多行时靠它归一）
    const merged: SceneDetect.BlackRange[] = []
    for (const range of ranges) {
        const last = merged[merged.length - 1]
        if (last && range.startMs <= last.endMs) {
            last.endMs = Math.max(last.endMs, range.endMs)
            last.durationMs = last.endMs - last.startMs
            continue
        }
        merged.push({ ...range })
    }
    return merged
}

/** 组装 ffmpeg 参数：只解 [fromMs, fromMs+lenMs) 这一段，输出丢弃（-f null），只取 stderr 里的日志 */
const buildArgs = (input: string, fromMs: number, lenMs: number, filter: string): string[] => [
    '-hide_banner',
    // 必须保留 info 级：black_start/black_end 就是 INFO 日志，压到 error 会一个字都拿不到
    '-loglevel',
    'info',
    '-ss',
    (fromMs / 1000).toFixed(3),
    '-t',
    (lenMs / 1000).toFixed(3),
    '-i',
    input,
    '-vf',
    filter,
    '-an',
    '-f',
    'null',
    '-',
]

/** blackdetect 滤镜串（d/pic_th/pix_th 三个阈值） */
const buildFilter = (options: BlackDetectOptions): string =>
    `blackdetect=d=${options.minDurationSec}:pic_th=${options.picThreshold}:pix_th=${options.pixThreshold}`

/** 跑一次窗口扫描并解析；超时 SIGKILL（与 probe/frameExtract 同一看门狗模板） */
const runScan = (
    input: string,
    fromMs: number,
    lenMs: number,
    openEndMs: number,
    filter: string,
    timeoutMs: number,
): Promise<SceneDetect.BlackRange[]> =>
    new Promise<SceneDetect.BlackRange[]>((resolve, reject) => {
        const proc = spawn('ffmpeg', buildArgs(input, fromMs, lenMs, filter), {
            windowsVerbatimArguments: false,
        })

        let err = ''
        let settled = false

        const timer = setTimeout(() => {
            finish(() => reject(new Error(`黑帧检测超时（${timeoutMs}ms）：${input} @ ${fromMs}ms+${lenMs}ms`)))
            try {
                proc.kill('SIGKILL')
            } catch {
                // 进程可能已退出
            }
        }, timeoutMs)
        timer.unref()

        /** 只允许 settle 一次，并统一清理看门狗定时器 */
        function finish(action: () => void): void {
            if (settled) return
            settled = true
            clearTimeout(timer)
            action()
        }

        // stderr 必须持续消费：不读会写满管道把 ffmpeg 阻塞住，日志也就永远不完整
        proc.stderr.on('data', (d: Buffer) => { err += d.toString() })

        proc.on('close', (code) => {
            finish(() => {
                if (code === 0) {
                    resolve(parseBlackDetectRanges(err, fromMs, openEndMs))
                    return
                }
                const tail = err.trim().split(/\r?\n/).slice(-5).join('\n')
                reject(new Error(`黑帧检测失败（退出码 ${code}）：${input}\n${tail}`))
            })
        })
        proc.on('error', (e) => finish(() => reject(new Error(`启动 ffmpeg 失败：${e.message}`))))
    })

/**
 * 检测源视频**首尾两段窗口**内的黑场，返回源视频全局 ms 的区间（按时间升序）。
 *
 * 只扫窗口是刻意的：本能力的用途是「开头/结尾检测」，全片黑场扫描等于再完整解码一遍视频，
 * 对长片是分钟级开销，得不偿失。窗口长度由调用方给定（见 AiDetect.DetectOptions.blackDetectSec）。
 */
export const detectBlackFrames = async (
    videoAbs: string,
    options: BlackDetectOptions,
): Promise<SceneDetect.BlackRange[]> => {
    const input = path.resolve(videoAbs)
    if (!fs.existsSync(input)) throw new Error(`黑帧检测输入视频不存在：${input}`)

    const windowMs = Math.max(0, Math.round(options.windowMs))
    if (windowMs <= 0) return []

    const durationMs = Math.max(0, Math.round(options.durationMs))
    const filter = buildFilter(options)
    const timeoutMs =
        typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : BLACK_DETECT_TIMEOUT_MS

    // 两个窗口已经重叠（或时长未知）：只扫一次，结果同时用于首尾判断，省掉重复解码
    if (durationMs <= 0 || windowMs * 2 >= durationMs) {
        const lenMs = durationMs > 0 ? durationMs : windowMs
        const openEndMs = durationMs > 0 ? durationMs : lenMs
        return runScan(input, 0, lenMs, openEndMs, filter, timeoutMs)
    }

    const head = await runScan(input, 0, windowMs, windowMs, filter, timeoutMs)
    const tail = await runScan(input, durationMs - windowMs, windowMs, durationMs, filter, timeoutMs)
    return [...head, ...tail].sort((a, b) => a.startMs - b.startMs)
}
