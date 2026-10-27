// audioClip.ts
//
// 按时间区间提取音频：从源视频切出 `[startMs, endMs)` 的音频存成 16k 单声道 wav。
//
// 为什么不复用 extractAudio.ts 的 extractAudioToWav：
// ① 它没有区间参数（永远提取整条音轨），而转写要按固定时长切块（单块受 ASR_MAX_AUDIO_BYTES 约束）；
// ② 它经 runFfmpeg 执行，而 runFfmpeg **没有超时** —— 一部长片要逐块提取，任一次挂起都会让
//    dispatcher 的在途计数卡到 AI_DETECT_TASK_STALE_MS 才恢复，与抽帧那条路是同一个理由。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import {
    AUDIO_CLIP_BYTES_PER_SEC,
    AUDIO_CLIP_CHANNELS,
    AUDIO_CLIP_SAMPLE_RATE,
    AUDIO_CLIP_TIMEOUT_MS,
} from '../constant/video.ts'

/** 合法 wav 至少要有 44 字节头（PCM），低于它说明 ffmpeg 没真写出音频 */
const WAV_HEADER_BYTES = 44

/** 音频切块入参 */
export interface ExtractAudioClipOptions {
    /** 区间起点（ms，含） */
    startMs: number
    /** 区间终点（ms，不含） */
    endMs: number
    /** 子进程超时（ms），缺省 AUDIO_CLIP_TIMEOUT_MS */
    timeoutMs?: number
}

/**
 * 提取 `[startMs, endMs)` 的音频到 outputAbs（16k 单声道 wav）。
 *
 * `-ss` 放在 `-i` **之前**（输入侧定位）：先跳到目标点前最近的关键帧再向前解码，避免为了一块音频
 * 从头解码整段视频。
 *
 * 终点用 `-t <时长>` 而不是 `-to <终点>`：`-to` 在「输入侧 seek」下的语义（绝对时间 vs 相对 seek
 * 点）随 ffmpeg 版本/参数组合而异，写错了块会长出一截（后续块的文本会与它重合）。`-t` 表示
 * 「从 seek 点起再输出这么长」，语义唯一，故这里显式换算成时长。
 *
 * 与抽帧一样带看门狗：超时 SIGKILL 并 reject，且校验产物字节数（超出源时长的区间会「成功退出但没写出音频」）。
 */
export const extractAudioClip = (
    inputAbs: string,
    outputAbs: string,
    options: ExtractAudioClipOptions,
): Promise<void> =>
    new Promise((resolve, reject) => {
        const { startMs, endMs } = options
        const timeoutMs = options.timeoutMs ?? AUDIO_CLIP_TIMEOUT_MS
        // 时长由调用方的区间算出（负数/非法一律按 0 处理，交给 ffmpeg 自己报错）
        const durationSec = Math.max(0, (endMs - startMs) / 1000).toFixed(3)

        const proc = spawn(
            'ffmpeg',
            [
                '-hide_banner',
                '-loglevel', 'error',
                '-y',
                '-ss', (startMs / 1000).toFixed(3),
                '-i', inputAbs,
                '-t', durationSec,
                '-vn', // 去掉视频流，只留音轨
                '-ac', String(AUDIO_CLIP_CHANNELS),
                '-ar', String(AUDIO_CLIP_SAMPLE_RATE),
                '-f', 'wav',
                outputAbs,
            ],
            { windowsVerbatimArguments: false },
        )

        let err = ''
        let settled = false

        const timer = setTimeout(() => {
            finish(() =>
                reject(
                    new Error(
                        `提取音频超时（${timeoutMs}ms）：${inputAbs} @ ${startMs}-${endMs}ms`,
                    ),
                ),
            )
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

        proc.stderr.on('data', (d: Buffer) => {
            err += d.toString()
        })

        proc.on('close', (code) => {
            finish(() => {
                if (code !== 0) {
                    reject(new Error(`FFmpeg 提取音频失败（退出码 ${code}）：${err.trim() || '无错误输出'}`))
                    return
                }
                const written = fs.existsSync(outputAbs) ? fs.statSync(outputAbs).size : 0
                // 必须按「该区间应有的时长」校验，而不是只看「有没有写出东西」：
                // 区间超出视频末尾、或音轨本身比视频短时，ffmpeg 会**成功退出**却只写个 44 字节头
                // 加几十字节空数据（实测 78B）。那种产物送去转写只会白跑一次，且掩盖了真实原因。
                // 留 10% 余量吸收 wav 头与帧对齐（16k 单声道 16bit ⇒ 每秒 AUDIO_CLIP_BYTES_PER_SEC 字节）。
                const expectedBytes = (Number(durationSec) * AUDIO_CLIP_BYTES_PER_SEC)
                const minBytes = Math.max(WAV_HEADER_BYTES + 1, Math.floor(expectedBytes * 0.9))
                if (written >= minBytes) {
                    resolve()
                    return
                }
                reject(
                    new Error(
                        `FFmpeg 产出的音频过短（${written}B，期望约 ${Math.round(expectedBytes)}B）：` +
                            `区间 ${startMs}-${endMs}ms 可能超出视频长度，或该视频的音轨比画面短`,
                    ),
                )
            })
        })

        proc.on('error', (e) => finish(() => reject(new Error(`启动 FFmpeg 失败: ${e.message}`))))
    })
