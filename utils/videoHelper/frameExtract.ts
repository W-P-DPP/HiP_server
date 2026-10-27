// frameExtract.ts
//
// 单帧抽帧：在视频的指定时间点解一帧、写成 jpg。
//
// 为什么不复用 runFfmpeg（utils/videoHelper/ffmpeg.ts）：
// ① runFfmpeg **没有超时**。抽帧一个任务要做「3 × 场景数」次子进程调用（长视频可达上千次），
//    任一次挂起都会让 dispatcher 的在途计数永不复位，任务要等到 AI_DETECT_TASK_STALE_MS
//    才被当成孤儿重排 —— 与 probe.ts 加看门狗是同一个理由。
// ② runFfmpeg 会按 GPU 配置做参数变换，而它的变换只认 `-c:v libx264`；抽帧输出的是 jpg
//    （走 mjpeg 编码），toGpuArgs 恒返回 null，等于每次白跑一次 GPU 能力探测并刷一整段 stderr 日志。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { FRAME_EXTRACT_TIMEOUT_MS, FRAME_EXTRACT_JPEG_QUALITY } from '../constant/video.ts'

/** 单帧抽帧入参 */
export interface ExtractFrameOptions {
    /** 目标时间点（ms）；调用方须保证落在 [0, 视频时长) 内 */
    atMs: number
    /** 输出图片的绝对路径（约定 .jpg） */
    destAbs: string
    /** jpg 质量（`-q:v`，2..31，越小越好），缺省 FRAME_EXTRACT_JPEG_QUALITY */
    quality?: number
    /** 子进程超时（ms），缺省 FRAME_EXTRACT_TIMEOUT_MS */
    timeoutMs?: number
}

/**
 * 在 atMs 处抽一帧到 destAbs（jpg）。失败一律 reject，并把 ffmpeg 的 stderr 带进错误信息。
 *
 * `-ss` 刻意放在 `-i` **之前**：输入侧定位会先跳到目标点之前的关键帧、再向前解码到精确时间，
 * 避免从头解码整段视频（输出侧 `-ss` 要解完前面所有帧，长视频上慢得多）；精度上现代 ffmpeg
 * 默认开启 accurate_seek，落到的仍是目标时间点那一帧。
 */
export const extractFrame = (videoAbs: string, options: ExtractFrameOptions): Promise<void> =>
    new Promise((resolve, reject) => {
        const { atMs, destAbs } = options
        const quality = options.quality ?? FRAME_EXTRACT_JPEG_QUALITY
        const timeoutMs = options.timeoutMs ?? FRAME_EXTRACT_TIMEOUT_MS

        const proc = spawn(
            'ffmpeg',
            [
                '-hide_banner',
                '-loglevel', 'error',
                '-y',
                '-ss', (atMs / 1000).toFixed(3),
                '-i', videoAbs,
                '-frames:v', '1',
                '-q:v', String(quality),
                destAbs,
            ],
            { windowsVerbatimArguments: false },
        )

        let err = ''
        let settled = false

        // 挂起兜底：见文件头说明，抽帧次数极多，任一次卡住都会拖垮调度器。
        const timer = setTimeout(() => {
            finish(() =>
                reject(new Error(`抽帧超时（${timeoutMs}ms）：${videoAbs} @ ${atMs}ms`)),
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
                    reject(new Error(`FFmpeg 抽帧失败（退出码 ${code}）：${err.trim() || '无错误输出'}`))
                    return
                }
                // ffmpeg 在时间点超出流末尾时会「成功退出但没写出文件」；这里必须自己确认产物，
                // 否则空产物会一路流到登记阶段，变成 file 表里一条指向不存在文件的记录。
                const written = fs.existsSync(destAbs) ? fs.statSync(destAbs).size : 0
                if (written > 0) {
                    resolve()
                    return
                }
                reject(new Error(`FFmpeg 未产出图片（时间点 ${atMs}ms 可能超出视频长度）：${videoAbs}`))
            })
        })

        proc.on('error', (e) => finish(() => reject(new Error(`启动 FFmpeg 失败: ${e.message}`))))
    })
