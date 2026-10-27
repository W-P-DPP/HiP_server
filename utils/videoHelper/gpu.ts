// gpu.ts —— ffmpeg 硬件能力探测 / FFMPEG_GPU 解析 / -c:v libx264 → 硬件编码参数变换 / cuda 解码+缩放注入
import { spawn } from 'node:child_process'
import {
    HW_H264_ENCODERS,
    GPU_BITRATE,
    H264_PRESET_MAP,
    AMF_QUALITY_MAP,
    CUDA_HWACCEL,
    CUDA_HWACCEL_OUTPUT_FORMAT,
    CUDA_SCALE_FILTER,
    VIDEO_FILE_EXT,
} from '../constant/video.ts'

/** 硬件加速配置：encoder 必填；hwaccel/scaleFilter 仅 nvenc+cuda 探测成功时填充 */
export interface GpuConfig {
    encoder: string;
    /** 硬件解码 hwaccel 值（cuda） */
    hwaccel?: string;
    /** -hwaccel_output_format 值（cuda） */
    outputFormat?: string;
    /** 硬件缩放滤镜（scale_cuda），替换 -vf 链中的 scale= */
    scaleFilter?: string;
}

type GpuMode = 'off' | 'auto' | 'on';

/**
 * FFMPEG_GPU 三态解析：off=强制 CPU，on=启用（未检测到时警告），其余（含默认）auto。
 * 纯函数，便于测试。
 */
export const parseGpuMode = (raw: string | undefined): GpuMode => {
    const v = raw?.trim().toLowerCase();
    if (v === 'off') return 'off';
    if (v === 'on') return 'on';
    return 'auto';
};

// 检测结果缓存：缓存的是 Promise，并发调用共享同一次探测；null=已解析为无 GPU
let gpuConfigPromise: Promise<GpuConfig | null> | null = null;
// 硬件解码/缩放失败后置位：进程内禁用解码/缩放，仅保留编码 GPU
let hwDecodeDisabled = false;

/** 惰性、进程级缓存的 GPU 配置探测；FFMPEG_GPU=off 时不 spawn 直接返回 null */
export const getGpuConfig = async (): Promise<GpuConfig | null> => {
    if (!gpuConfigPromise) gpuConfigPromise = resolveGpuConfig();
    const cfg = await gpuConfigPromise;
    if (!cfg) return null;
    if (hwDecodeDisabled) return { encoder: cfg.encoder }; // 解码/缩放已降级，仅编码走 GPU
    return cfg;
};

const resolveGpuConfig = async (): Promise<GpuConfig | null> => {
    const mode = parseGpuMode(process.env.FFMPEG_GPU);
    if (mode === 'off') return null;
    const caps = await detectGpuCaps();
    if (caps) return caps;
    if (mode === 'on') {
        console.warn('[gpu] FFMPEG_GPU=on 但未检测到硬件编码器，已降级 CPU 编码');
    } else {
        console.log('[gpu] 未检测到可用硬件编码器，使用 CPU 编码');
    }
    return null;
};

/** 运行时 GPU 编码失败后调用：本次进程内永久切回 CPU，避免反复重试 */
export const disableGpu = (): void => {
    gpuConfigPromise = Promise.resolve(null);
};

/** 硬件解码/缩放失败后调用：本次进程内禁用解码/缩放，编码仍走 GPU */
export const disableHwDecode = (): void => {
    hwDecodeDisabled = true;
};

/** 测试钩子：清空缓存，允许下次调用重新探测 */
export const resetGpuCache = (): void => {
    gpuConfigPromise = null;
    hwDecodeDisabled = false;
};

/** 单次组合探测：-encoders + -hwaccels + -filters 一次 spawn 输出三块，避免三次进程开销 */
const detectGpuCaps = async (): Promise<GpuConfig | null> => {
    try {
        const out = await captureOutput(['-hide_banner', '-encoders', '-hwaccels', '-filters']);
        const encoder = pickFirstEncoder(out);
        if (!encoder) return null;
        const caps: GpuConfig = { encoder };
        // 仅 nvenc 族追加 cuda 解码+缩放；qsv/amf/videotoolbox 维持仅编码（滤镜名/帧格式差异大，暂不注入）
        if (encoder.includes('nvenc') && hasToken(out, CUDA_HWACCEL)) {
            caps.hwaccel = CUDA_HWACCEL;
            caps.outputFormat = CUDA_HWACCEL_OUTPUT_FORMAT;
            if (hasToken(out, CUDA_SCALE_FILTER)) caps.scaleFilter = CUDA_SCALE_FILTER;
        }
        return caps;
    } catch {
        // ffmpeg 缺失/不可执行 → 视为无硬件能力（走 CPU）
        return null;
    }
};

/** 按 HW_H264_ENCODERS 优先级返回第一个出现在 -encoders 输出中的硬件编码器 */
const pickFirstEncoder = (out: string): string | null => {
    for (const enc of HW_H264_ENCODERS) {
        if (hasToken(out, enc)) return enc;
    }
    return null;
};

/** 组合输出中是否出现独立 token（行首/空白分隔），避免误匹配 scale_cuda 中的 cuda 子串 */
const hasToken = (out: string, token: string): boolean =>
    new RegExp(`(^|\\s)${token}(\\s|$)`).test(out);

/** spawn ffmpeg 并合并收集 stdout+stderr（各 dump 列表在 stdout，banner 在 stderr），close 后 resolve */
const captureOutput = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { windowsVerbatimArguments: false });
        let out = '';
        proc.stdout?.on('data', (chunk: Buffer) => {
            out += chunk.toString();
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
            out += chunk.toString();
        });
        proc.on('error', reject);
        proc.on('close', () => resolve(out));
    });

/**
 * 纯函数：把 `-c:v libx264` 编码替换为硬件编码器；nvenc+cuda 可用时追加硬件解码 + scale_cuda 缩放。
 * 第二参兼容字符串（仅编码变换）或 GpuConfig（含 hwaccel 时注入解码/缩放）。
 * 只处理显式 `-c:v libx264` 的数组；concat（`-c copy`）、libx265 等无匹配的返回 null（不变换）。
 * - preset 处理与编码器位置无关（第二遍扫描）；amf 将 `-preset X` 整组替换为 `-quality Y`。
 * - 无 `-b:v` 时在编码器后补码率（硬件编码器无默认/默认过低），已含则跳过。
 */
export const toGpuArgs = (args: string[], cfg: string | GpuConfig): string[] | null => {
    const encoder = typeof cfg === 'string' ? cfg : cfg.encoder;

    let swapIdx = -1;
    for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '-c:v' && args[i + 1] === 'libx264') {
            swapIdx = i;
            break;
        }
    }
    if (swapIdx === -1) return null;

    const next = args.slice();
    next[swapIdx + 1] = encoder;

    for (let i = 0; i < next.length - 1; i++) {
        if (next[i] === '-preset') {
            const libx = next[i + 1] ?? '';
            if (encoder === 'h264_amf') {
                next.splice(i, 2, '-quality', AMF_QUALITY_MAP[libx] ?? 'balanced');
            } else {
                const mapped = H264_PRESET_MAP[encoder]?.[libx];
                if (mapped && mapped !== libx) next[i + 1] = mapped;
            }
            break;
        }
    }

    if (!next.includes('-b:v')) {
        next.splice(swapIdx + 2, 0, '-b:v', GPU_BITRATE);
    }

    // 追加：cuda 解码 + 缩放注入（toVideo 含 subtitles= 时不注入，libass 强制回落 CPU 收益低风险高）
    if (typeof cfg !== 'string' && cfg.hwaccel && !hasSubtitlesFilter(next)) {
        injectHwDecode(next, cfg.hwaccel, cfg.outputFormat, cfg.scaleFilter);
    }
    return next;
};

/** -vf 是否含字幕烧录滤镜（libass，纯 CPU） */
const hasSubtitlesFilter = (args: string[]): boolean =>
    args.some((t, i) => t === '-vf' && (args[i + 1] ?? '').includes('subtitles='));

/**
 * 注入硬件解码 + scale_cuda 缩放（就地修改 args）：
 * - 每个真实视频输入（非 lavfi 合成源、扩展名命中 VIDEO_FILE_EXT）前插入 -hwaccel/-hwaccel_output_format；
 * - 仅当至少一个输入被注入解码时，才把 -vf 链中的 scale= 替换为 scaleFilter
 *   （否则颜色兜底段无 GPU 输入，scale_cuda 吃到 CPU 帧会报错）。
 */
const injectHwDecode = (
    args: string[],
    hwaccel: string,
    outputFormat: string | undefined,
    scaleFilter: string | undefined,
): void => {
    let hwInjected = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '-i') continue;
        // lavfi 合成源：-f lavfi -i color=...（-i 前两 token 含 -f）
        if (args[i - 1] === '-f' || args[i - 2] === '-f') continue;
        const inputPath = args[i + 1] ?? '';
        // 仅真实视频文件参与硬件解码（音频 mp3 等跳过）
        if (!VIDEO_FILE_EXT.test(inputPath)) continue;
        args.splice(i, 0, '-hwaccel', hwaccel, '-hwaccel_output_format', outputFormat ?? hwaccel);
        hwInjected = true;
        i += 4; // 跳过刚插入的 4 个 token 与已消费的 -i（循环 i++ 后落在 inputPath 之后）
    }
    if (hwInjected && scaleFilter) {
        for (let i = 0; i < args.length - 1; i++) {
            if (args[i] === '-vf') {
                const vf = args[i + 1] ?? '';
                args[i + 1] = vf.replace(/(^|,)scale=/, `$1${scaleFilter}=`);
                break;
            }
        }
    }
};
