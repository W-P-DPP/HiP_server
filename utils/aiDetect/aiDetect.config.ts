// utils/aiDetect/aiDetect.config.ts
/** AI 检测（视频场景切分）：总开关、体积上限、URL 下载安全参数、后台调度器 */

/** 从 env 读整数，非法值/缺省回退默认值（?x=abc 类输入不应让配置变成 NaN） */
function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 从 env 读布尔，只有显式 'true'/'1' 才算真 */
function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** 从 env 读浮点数，非法值/缺省回退默认值（阈值类参数需要小数，故不能用 envInt） */
function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 把比例类参数夹到 [0,1]：超范围的值会让 ffmpeg 的 pic_th/pix_th 行为不可预期 */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const aiDetectConfig = {
  /** 总开关：关闭时提交接口直接 503，调度器不启动 */
  enabled: envBool(process.env.AI_DETECT_ENABLED, true),

  /**
   * 源视频上限（字节），**整份上传的传输上限 + 业务上限 + 分片合并后的上限**三处同一口径：
   * 场景切分的诉求就是大文件，上限必须与素材库的大文件量级对齐（2.5GB），否则大文件在
   * multer 那一层就被拒（提示「文件大小不能超过 xxxMB」），根本进不到检测链路。
   *
   * 传输上限仍按路由给（见 utils/middleware/uploadMiddleware.ts 的 uploadDetectVideo / uploadDetectChunk），
   * 而不是抬升全局 FILE_MAX_SIZE —— 后者是给所有上传接口（skill 包、公众号素材、音色样本…）共用的。
   * 大文件若怕单请求中断，客户端可改走分片口径（见下方 chunk 与 scene/chunks/* 接口），两者上限一致。
   */
  maxVideoBytes: envInt(process.env.AI_DETECT_MAX_VIDEO_BYTES, 2.5 * 1024 * 1024 * 1024),

  /**
   * 大文件分片上传（POST /api/aiDetect/scene/chunks/*）。
   *
   * 只放分片**通道自身**的参数：单片传输上限、分片数、会话寿命。合并后的体量上限不在这里，
   * 而是与整份上传共用 maxVideoBytes —— 两者是同一个业务口径（源视频上限），分成两个 knob
   * 只会让「整份能收、分片收不了」或反之这类不一致有地方藏。
   */
  chunk: {
    /** 单个分片大小上限（字节），同时是分片路由 multer 的传输上限 */
    maxChunkBytes: envInt(process.env.AI_DETECT_CHUNK_MAX_CHUNK_BYTES, 16 * 1024 * 1024),
    /** 分片数上限：每片至少落一个文件，防止 totalChunks 被填成天文数字耗光 inode */
    maxChunks: envInt(process.env.AI_DETECT_CHUNK_MAX_CHUNKS, 10_000),
    /**
     * 未完成会话的存活时长（ms）。分片上传没有常驻调度器，故在新建会话时顺带清理超期会话目录，
     * 让异常中断（客户端放弃、进程被杀）留下的分片不会永久占盘。取值须大于一次完整上传的耗时。
     */
    sessionTtlMs: envInt(process.env.AI_DETECT_CHUNK_SESSION_TTL_MS, 24 * 60 * 60 * 1000),
  },

  /** 缺省检测算法（content / adaptive / threshold），提交未指定时使用 */
  defaultDetector: process.env.AI_DETECT_DEFAULT_DETECTOR || 'content',

  /**
   * 场景抽帧（POST /api/aiDetect/frames/tasks，见 aiDetectDispatcher 的 runFrames）。
   *
   * 抽帧基于**已完成的场景切分任务**：按每个场景的起止时间用 ffmpeg 抽开始/中间/结束三帧，
   * 逐帧登记 file 表。全量抽、不缩放 —— 场景数不设上限，成本由源视频本身决定。
   */
  frames: {
    /** 单帧抽帧子进程超时（ms）。抽帧是短任务，但一个任务有 3×场景数 次调用，必须有独立看门狗 */
    extractTimeoutMs: envInt(process.env.AI_DETECT_FRAME_EXTRACT_TIMEOUT_MS, 30_000),
    /** 抽帧 jpg 质量（ffmpeg `-q:v`，2..31，越小越好）。原尺寸输出，靠质量参数控制体积 */
    jpegQuality: envInt(process.env.AI_DETECT_FRAME_JPEG_QUALITY, 3),
    /**
     * 抽帧队列的在途任务数上限。
     *
     * 与场景切分的 scheduler.concurrency **互相独立**：抽帧任务在另一张表、另一条队列上领取，
     * 填满本额度不会占用场景切分的额度（反之亦然）。填 2 时全机可同时跑 2 条抽帧任务 + 场景切分各自的上限。
     */
    concurrency: Math.max(1, envInt(process.env.AI_DETECT_FRAME_CONCURRENCY, 1)),
  },

  /**
   * 场景转写（POST /api/aiDetect/asr/tasks，见 aiDetectDispatcher 的 runAsr）。
   *
   * 基于**已完成的场景切分任务**：抽音频 → 复用 subtitle 模块的 Whisper 链路转写 → 把分段文本
   * 按场景区间归并。转写本身不在本进程内跑，这里只配「怎么切块」与「等子任务多久」。
   */
  asr: {
    /**
     * 转写队列的在途任务数上限（与另外两条队列互相独立）。
     * 注意真正的算力闸门在 subtitle 侧（SUBTITLE_CONCURRENCY）—— 本值只决定 aiDetect 能同时
     * 推进几条转写任务，调大不会让 Whisper 更快。
     */
    concurrency: Math.max(1, envInt(process.env.AI_DETECT_ASR_CONCURRENCY, 1)),

    /**
     * 音频切块时长（ms，默认 10 分钟）。
     *
     * 存在的理由：subtitle 链路对音频卡 ASR_MAX_AUDIO_BYTES（默认 50MB），而 16k 单声道 wav
     * 每秒 32KB ⇒ 约 26 分钟就到顶，长片必须切块。10 分钟块 ≈ 19.2MB，留有充足余量。
     * 调整本值时必须保证 `chunkMs/1000 × 32KB ≤ ASR_MAX_AUDIO_BYTES`（单测里有这条断言）。
     */
    chunkMs: Math.max(1_000, envInt(process.env.AI_DETECT_ASR_CHUNK_MS, 10 * 60_000)),

    /** 单块音频提取子进程超时（ms）。只解音轨，10 分钟块通常几秒；给足余量兜挂起 */
    extractTimeoutMs: envInt(process.env.AI_DETECT_ASR_EXTRACT_TIMEOUT_MS, 300_000),

    /**
     * 等待**单个块**转写完成的上限（ms）。
     * 必须 ≥ SUBTITLE_TASK_STALE_MS（默认 30 分钟），否则合法的长块会被本侧提前判超时 ——
     * 与 videoPipelineV2 的 subtitleTimeoutMs 是同一条约束。
     */
    subtitleTimeoutMs: envInt(process.env.AI_DETECT_ASR_SUBTITLE_TIMEOUT_MS, 30 * 60_000),
  },

  /**
   * 首尾黑帧检测（ffmpeg blackdetect，见 utils/videoHelper/blackDetect.ts）。
   *
   * 只有提交时显式给了 `blackDetectSec > 0` 才跑，且**只扫首尾两段窗口**（不做全片扫描）：
   * 用途是「片头/片尾黑场」，全片扫描等于为这个用途再完整解码一遍视频。
   * 下面三个是判黑口径，与「扫多久」无关 —— 扫多久由请求参数决定。
   */
  black: {
    /**
     * 黑场最短时长（秒，ffmpeg 的 `d=`）。
     *
     * 短于此长度的暗帧不算黑场：正常素材里的压暗镜头、黑场过渡的中间帧都会有一两帧很暗，
     * 但它们不是「片头片尾黑屏」。给 1s 是为了不被单帧噪声触发，同时仍能识别常见的 1~2s 黑场。
     */
    minDurationSec: Math.max(0, envNumber(process.env.AI_DETECT_BLACK_MIN_DURATION_SEC, 1)),
    /**
     * 整帧判黑所需的「判黑像素」比例下限（`pic_th=`，0..1）。
     * 0.98 = 一帧里 98% 以上的像素都判黑，整帧才算黑 —— 容忍编码噪点与边缘留白。
     */
    picThreshold: clamp01(envNumber(process.env.AI_DETECT_BLACK_PIC_TH, 0.98)),
    /**
     * 单像素判黑的亮度阈值（`pix_th=`，相对满量程，0..1）。
     * 0.1 = 亮度低于满量程 10% 的像素算黑；调大能容忍「非纯黑」的灰黑片头、但也会开始吃进暗场景。
     */
    pixThreshold: clamp01(envNumber(process.env.AI_DETECT_BLACK_PIX_TH, 0.1)),
  },

  /** URL 入参的安全参数（见 utils/videoHelper/remoteDownload.ts） */
  url: {
    /** 单个 URL 允许下载的最大字节数 */
    maxBytes: envInt(process.env.AI_DETECT_URL_MAX_BYTES, 200 * 1024 * 1024),
    /** 单次下载总超时（ms），覆盖全部重定向跳数 */
    timeoutMs: envInt(process.env.AI_DETECT_URL_TIMEOUT_MS, 120_000),
    /** 最大重定向跳数；每一跳都会重新做内网地址校验 */
    maxRedirects: envInt(process.env.AI_DETECT_URL_MAX_REDIRECTS, 5),
  },

  /**
   * 后台任务调度器（leader 租约 + 双队列 FIFO 领取，见 src/aiDetect/aiDetectDispatcher.ts）。
   *
   * 调度器只起一个进程持租约，但它管**两条彼此独立的队列**：场景切分（本段配置）与场景抽帧
   * （见下方 frames）。轮询间隔、进度节流、租约、陈旧阈值是两条队列共用的调度节奏，
   * 只有并发额度与抽帧自身的参数各配各的。
   */
  scheduler: {
    /** 调度 tick 间隔（ms） */
    pollIntervalMs: envInt(process.env.AI_DETECT_POLL_INTERVAL_MS, 3_000),
    /**
     * **场景切分队列**的在途任务数上限。检测跑在独立的 scenedetect HTTP 容器（纯 CPU 逐帧分析），
     * 真正的算力闸门在容器侧 `SCENEDETECT_MAX_CONCURRENCY`（=1），Node 侧默认 1 以免把请求堆在容器队列里。
     * 抽帧队列的额度另见 frames.concurrency，两者互不影响。
     */
    concurrency: Math.max(1, envInt(process.env.AI_DETECT_CONCURRENCY, 1)),
    /** 进度写库最小间隔（ms） */
    progressMinIntervalMs: envInt(process.env.AI_DETECT_PROGRESS_MIN_INTERVAL_MS, 1_000),
    /** leader 租约 TTL（ms），续期周期为 TTL/2 */
    leaseTtlMs: envInt(process.env.AI_DETECT_LEASE_TTL_MS, 60_000),
    /** 调度器 leader 租约键（与其它调度器各自独立） */
    leaderKey: process.env.AI_DETECT_LEADER_KEY || 'wxbot:aidetect:leader',
    /**
     * 陈旧任务判定阈值（ms）。必须大于一次最长检测耗时（长片可达数分钟），
     * 否则会把正在跑的长任务误判为孤儿并重排。
     */
    taskStaleMs: envInt(process.env.AI_DETECT_TASK_STALE_MS, 30 * 60_000),
  },
} as const;

export default aiDetectConfig;
