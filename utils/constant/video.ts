// 视频硬件编码常量

/** h264 硬件编码器探测优先级（按当前平台可用性排序；h264_videotoolbox 仅 macOS） */
export const HW_H264_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'] as const;

/** 硬件编码最低码率（nvenc 等无默认码率或默认过低，显式给出 1280x720 基准，防止无码率报错） */
export const GPU_BITRATE = '3000k';

/**
 * libx264 preset → 各硬件编码器 preset。
 * nvenc/videotoolbox 不接受 veryfast 等 libx264 档位名（映射到合法档位）；
 * qsv 接受 libx264 全套档位名（透传）；amf 不走 -preset，见 AMF_QUALITY_MAP。
 */
export const H264_PRESET_MAP: Record<string, Record<string, string>> = {
    h264_nvenc: {
        ultrafast: 'fast', superfast: 'fast', veryfast: 'fast', faster: 'fast', fast: 'fast',
        medium: 'medium', slow: 'slow', slower: 'slow', veryslow: 'slow',
    },
    h264_qsv: {
        ultrafast: 'veryfast', superfast: 'veryfast', veryfast: 'veryfast', faster: 'faster', fast: 'fast',
        medium: 'medium', slow: 'slow', slower: 'slower', veryslow: 'veryslow',
    },
    h264_videotoolbox: {
        ultrafast: 'fast', superfast: 'fast', veryfast: 'fast', faster: 'fast', fast: 'fast',
        medium: 'medium', slow: 'slow', slower: 'slow', veryslow: 'slow',
    },
};

/** libx264 preset → h264_amf -quality 值（amf 编码器不接受 -preset，需整组替换） */
export const AMF_QUALITY_MAP: Record<string, string> = {
    ultrafast: 'speed', superfast: 'speed', veryfast: 'speed', faster: 'speed', fast: 'speed',
    medium: 'balanced', slow: 'quality', slower: 'quality', veryslow: 'quality',
};

// ---- CUDA 硬件解码 + 缩放（仅 nvenc + cuda 可用时注入） ----

/** 硬件解码 hwaccel 值（-hwaccel） */
export const CUDA_HWACCEL = 'cuda';
/** 硬件解码输出帧格式（-hwaccel_output_format；帧驻留 GPU 内存，供 scale_cuda 消费） */
export const CUDA_HWACCEL_OUTPUT_FORMAT = 'cuda';
/** CUDA 硬件缩放滤镜名（替换 -vf 链中的 scale=） */
export const CUDA_SCALE_FILTER = 'scale_cuda';
/** 参与硬件解码的真实视频文件扩展名（lavfi 合成源、音频输入跳过） */
export const VIDEO_FILE_EXT = /\.(mp4|mov|mkv|avi|webm|mpeg|mpg|ts|flv|wmv)$/i;

/** ffprobe 探测超时（ms）。ffprobe 在畸形/超大文件上可能挂起，进而让 dispatcher 的 busy 永不复位 */
export const MEDIA_PROBE_TIMEOUT_MS = 30_000;

// ---- PySceneDetect 场景切分常量已迁至 utils/constant/scenedetect.ts ----

// ---- 首尾黑帧检测（ffmpeg blackdetect，只扫首尾两段窗口） ----

/**
 * 首尾黑帧检测子进程超时（ms）。
 *
 * 与场景检测不同，这里**只解首/尾两段窗口**（不是全片）：1080p 下解几十秒通常几秒内完成，
 * 故上限给 2 分钟已很宽裕。仍需看门狗 —— 任一次挂起都会让调度器的在途计数卡到陈旧阈值才恢复。
 */
export const BLACK_DETECT_TIMEOUT_MS = 120_000;

/**
 * 判定「黑场贴着头/尾」的容差（ms）。
 *
 * blackdetect 报的时间是「首帧 pts」，与 0 / 视频总长之间允许有取整、容器起始偏移造成的偏差，
 * 故不要求严格等于边界：black_start 落在 [0, 容差] 内即视为片头黑场，black_end 距末尾同样。
 * 这个容差只用于「算不算贴边」，不改变黑场自身的起止时间。
 */
export const BLACK_BOUNDARY_TOLERANCE_MS = 500;

/**
 * 黑场末端「已到达扫描边界」的判定容差（ms）。
 *
 * blackdetect 报的 black_end 是**最后一个黑帧的 pts**，所以一段黑场一直黑到窗口/视频末尾时，
 * 报出来的值会比边界小不到一帧（25fps 下差 40ms）。按这个容差把末端吸附到边界，
 * 既避免切出一个几十毫秒的碎片场景，也不会把真实内容误判成黑场
 * （黑场真结束的话，边界前至少隔着一个非黑帧）。
 * 取 100ms（25fps 两帧多）足以覆盖取整与容器起始偏移，又远小于任何有意义的画面时长。
 */
export const BLACK_EDGE_SNAP_MS = 100;

// ---- 场景关键帧抽帧（ffmpeg，一次一个时间点） ----

/**
 * 单帧抽帧子进程超时（ms）。
 *
 * 与场景检测不同，抽帧是「定位到时间点 → 解一帧 → 写 jpg」的短任务（快速定位下通常几十毫秒），
 * 但一个任务要做 3×场景数 次调用 —— 任一次挂起都会让 dispatcher 的在途计数永不复位，
 * 故必须有独立看门狗（短超时即可，30s 已远超正常耗时）。
 */
export const FRAME_EXTRACT_TIMEOUT_MS = 30_000;

/**
 * 抽帧 jpg 质量（ffmpeg 的 `-q:v`）。
 *
 * 取值 2..31，越小质量越高、体积越大：3 在「肉眼无损」与体积之间比较均衡，
 * 适合拿来给 VLM 做画面理解，也适合前端直接展示。
 */
export const FRAME_EXTRACT_JPEG_QUALITY = 3;

// ---- 按时间区间提取音频（转写切片用） ----

/**
 * 单块音频提取子进程超时（ms）。
 *
 * 抽一块音频只解音轨（`-vn`，不解视频帧），10 分钟块通常几秒内完成；但长片逐块提取时
 * 任一次挂起都会让调度器的在途计数卡到 `AI_DETECT_TASK_STALE_MS` 才恢复，故给足余量兜底。
 */
export const AUDIO_CLIP_TIMEOUT_MS = 300_000;

/**
 * 音频切块的采样率与声道数（与字幕模块的 `SUBTITLE_EXTRACT_SAMPLE_RATE` 同值但独立命名）。
 *
 * 16kHz 单声道 16bit 是语音识别模型的输入惯例，提前归一化可减少上传体积与服务端解码开销。
 * 这个值同时决定「一块音频有多大」，是切块时长与 50MB 上限之间的换算依据：
 * 每秒 16000 × 2 字节 = 32KB。
 */
export const AUDIO_CLIP_SAMPLE_RATE = 16_000;

/** 音频切块的声道数（单声道：语音识别不需要立体声，体积减半） */
export const AUDIO_CLIP_CHANNELS = 1;

/** 每秒单块音频的字节数（16bit PCM），供切块时长与体积上限的换算使用 */
export const AUDIO_CLIP_BYTES_PER_SEC =
  AUDIO_CLIP_SAMPLE_RATE * AUDIO_CLIP_CHANNELS * 2;

/** 视频合成任务队列常量 */
export class VideoTaskConstants {
  /**
   * 视频合成任务并发数（VIDEO_TASK_CONCURRENCY）。
   * 默认 1 = 每次只处理一次视频合成；0/负值/非数字按 1 处理。
   */
  public static readonly CONCURRENCY: number = 1;
}
