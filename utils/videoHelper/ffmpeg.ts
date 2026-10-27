// ffmpeg.ts
import { spawn } from 'node:child_process'
import { getGpuConfig, toGpuArgs, disableGpu, disableHwDecode } from './gpu.ts'

/**
 * 执行 ffmpeg（数组模式传参，无 shell 二次转义；与原 toVideo 私有实现一致）。
 * stderr 实时输出，close code 判定成败。供 toVideo 与 background 复用。
 */
const runOnce = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', args, {
            windowsVerbatimArguments: false,
        });

        let stderrOutput = '';
        ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString();
            stderrOutput += message;
            console.log(`FFmpeg 输出: ${message}`);
        });

        ffmpegProcess.on('close', (code) => {
            console.log(`子进程退出，退出码 ${code}`);
            if (code === 0) return resolve();
            reject(new Error(`FFmpeg 进程异常退出，退出码: ${code}\n错误信息: ${stderrOutput}`));
        });

        ffmpegProcess.on('error', (err) => {
            reject(new Error(`启动 FFmpeg 失败: ${err.message}`));
        });
    });

/**
 * 执行 ffmpeg，优先使用 GPU：硬件编码（自动把 -c:v libx264 替换为可用硬件编码器），
 * nvenc+cuda 可用时额外注入硬件解码 + scale_cuda 缩放。
 * 两级降级：GPU 全链路失败 → 禁用解码/缩放退回仅编码 GPU → 仍失败则禁用 GPU 走 CPU；不支持则直接走 CPU。
 * 参数透传，调用方无需感知编码器选择。
 */
export const runFfmpeg = async (args: string[]): Promise<void> => {
    const cfg = await getGpuConfig();
    if (cfg) {
        const gpuArgs = toGpuArgs(args, cfg);
        if (gpuArgs) {
            try {
                await runOnce(gpuArgs);
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`FFmpeg GPU 全链路失败（${cfg.encoder}），尝试仅编码 GPU: ${msg}`);
            }
            // 硬件解码/缩放失败 → 本次进程禁用解码/缩放，退回仅编码 GPU，再失败才全 CPU
            if (cfg.hwaccel) {
                disableHwDecode();
                const encArgs = toGpuArgs(args, { encoder: cfg.encoder });
                if (encArgs) {
                    try {
                        await runOnce(encArgs);
                        return;
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.warn(`FFmpeg GPU 编码失败（${cfg.encoder}），降级 CPU 重试: ${msg}`);
                    }
                }
            }
            // 仅编码也失败（或不可变换）→ 本次进程禁用 GPU，退回原始 CPU 参数
            disableGpu();
        }
    }
    await runOnce(args);
}
