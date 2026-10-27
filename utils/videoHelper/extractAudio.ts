// extractAudio.ts
import { runFfmpeg } from './ffmpeg.ts'
import { SUBTITLE_EXTRACT_SAMPLE_RATE } from '../constant/subtitle.ts'

/**
 * 从任意媒体文件（视频/音频）提取音轨，统一转成 16kHz 单声道 wav —— 语音识别的最优输入。
 *
 * 两点刻意为之：
 * - **不带 `-c:v`**：runFfmpeg 的硬件参数变换只认显式 `-c:v libx264`（见 gpu.ts 的 toGpuArgs，
 *   无匹配即返回 null），故这里不会被注入硬件编码器，纯音频输出稳定走 CPU。
 * - **`-vn` 而非 `-map 0:a:0`**：前者在「无音轨」时以 “Output file does not contain any stream” 失败，
 *   后者报 “Stream map matches no streams”，两者都能被调用方捕获；`-vn` 与既有的
 *   digitalHumanDispatcher 归一化写法一致，少一层流索引假设（多音轨素材取默认音轨即可）。
 *
 * 失败一律 reject（含 ffmpeg 非 0 退出与二进制缺失），由调用方决定是 400 还是任务失败态。
 */
export const extractAudioToWav = async (inputAbs: string, outputAbs: string): Promise<void> => {
    await runFfmpeg([
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inputAbs,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(SUBTITLE_EXTRACT_SAMPLE_RATE),
        '-f',
        'wav',
        outputAbs,
    ])
}
