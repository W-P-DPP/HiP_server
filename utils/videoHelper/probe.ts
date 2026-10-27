// probe.ts
import { spawn } from 'node:child_process'
import { MEDIA_PROBE_TIMEOUT_MS } from '../constant/video.ts'

/** 用 ffprobe 取媒体时长（秒）。失败抛错。 */
const probeDuration = (absPath: string): Promise<number> =>
    new Promise((resolve, reject) => {
        const proc = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            absPath,
        ], {
            windowsVerbatimArguments: false,
        });
        let out = '';
        let err = '';
        let settled = false;

        // ffprobe 在畸形/超大文件上可能挂起。调用方（dispatcher 的 persistResult）await 它时
        // 若永不返回，调度器的 busy 标志就永不复位，后续任务会一直停在 pending —— 必须自己兜底。
        const timer = setTimeout(() => {
            finish(() => reject(new Error(`ffprobe 探测超时（${MEDIA_PROBE_TIMEOUT_MS}ms）：${absPath}`)));
            try {
                proc.kill('SIGKILL');
            } catch {
                // 进程可能已退出
            }
        }, MEDIA_PROBE_TIMEOUT_MS);
        timer.unref();

        /** 只允许 settle 一次，并统一清理看门狗定时器 */
        function finish(action: () => void): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            action();
        }

        proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
        proc.on('close', (code) => {
            finish(() => {
                const sec = Number.parseFloat(out.trim());
                if (code === 0 && Number.isFinite(sec)) {
                    resolve(sec);
                    return;
                }
                reject(new Error(`ffprobe 获取时长失败: ${err.trim() || `退出码 ${code}`}`));
            });
        });
        proc.on('error', (e) => finish(() => reject(new Error(`启动 ffprobe 失败: ${e.message}`))));
    });

export const probeDurationSec = (absPath: string): Promise<number> => probeDuration(absPath);

export const probeDurationMs = async (absPath: string): Promise<number> =>
    Math.round((await probeDuration(absPath)) * 1000)
