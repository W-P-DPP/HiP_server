declare namespace NodeJS {
  interface ProcessEnv {
    /** 服务器端口 */
    PORT: string;
    /** 运行环境 */
    NODE_ENV: 'development' | 'production' | 'test';
    /** 进程时区（默认 Asia/Shanghai，Docker 容器需显式指定） */
    TZ?: string;

    // ---- JWT ----
    /** 是否启用 JWT 鉴权 */
    JWT_ENABLED: string;
    /** JWT 签名密钥 */
    JWT_SECRET: string;

    // ---- 日志 ----
    /** 日志文件保留天数 */
    LOG_MAX_FILES: string;

    // ---- Redis ----
    /** Redis 主机地址 */
    REDIS_HOST: string;
    /** Redis 端口 */
    REDIS_PORT: string;
    /** Redis 连接 URL（优先级高于 REDIS_HOST/REDIS_PORT） */
    REDIS_URL?: string;
    /** Redis 密码（可选，设置后自动拼接进 URL） */
    REDIS_PASSWORD?: string;

    // ---- 数据库 ----
    /** 数据库类型 */
    DB_TYPE: string;
    /** 数据库主机地址 */
    DB_HOST: string;
    /** 数据库端口 */
    DB_PORT: string;
    /** 数据库用户名 */
    DB_USER: string;
    /** 数据库密码 */
    DB_PASSWORD: string;
    /** 数据库名称 */
    DB_NAME: string;
    /** 数据库连接池大小 */
    DB_CONNECTION_LIMIT: string;
    /** 数据库连接池等待 */
    DB_WAIT_FOR_CONNECTIONS: string;
    /** 数据库连接池队列限制 */
    DB_QUEUE_LIMIT: string;
    /** 数据库时区 */
    DB_TIMEZONE: string;
    /** 数据库字符集 */
    DB_CHARSET: string;

    // ---- MongoDB ----
    /** MongoDB 主机地址 */
    MONGO_HOST: string;
    /** MongoDB 端口 */
    MONGO_PORT: string;
    /** MongoDB 用户名 */
    MONGO_USER: string;
    /** MongoDB 密码 */
    MONGO_PASSWORD: string;
    /** MongoDB 数据库名 */
    MONGO_DATABASE: string;
    /** MongoDB 认证库 */
    MONGO_AUTH_SOURCE: string;
    /** MongoDB 完整连接 URL（优先级高于字段拼接） */
    MONGO_URL?: string;

    // ---- 操作日志 ----
    /** 操作日志白名单（逗号分隔） */
    OPERATION_LOG_WHITELIST: string;

    // ---- 邮件服务 ----
    /** SMTP 发件服务器地址 */
    MAILER_HOST: string;
    /** SMTP 发件服务器端口 */
    MAILER_PORT: string;
    /** SMTP 是否使用 TLS */
    MAILER_SECURE: string;
    /** SMTP 发件账号 */
    MAILER_USER: string;
    /** SMTP 发件密码 */
    MAILER_PASS: string;
    /** 发件人地址（缺省回退 MAILER_USER） */
    MAILER_FROM?: string;
    /** 发件人显示名 */
    MAILER_FROM_NAME?: string;
    /** 邮件服务总开关（false 时发信接口返回 503）。默认 true */
    MAILER_ENABLED?: string;

    // XUNFEI
    XUNFEI_APPID:string
    XUNFEI_APIKey:string
    XUNFEI_APISecret:string
    /** 音色训练完成回调地址（XFYun 训练完成推送） */
    XUNFEI_TRAIN_CALLBACK:string

    // ---- 视频素材 ----
    /** Pixabay API key（视频背景素材搜索；留空则回退纯色背景） */
    PIXABAY_API_KEY?: string;

    // ---- ffmpeg GPU 加速 ----
    /** ffmpeg 硬件编码：off=强制 CPU，auto=自动检测（默认），on=启用（缺失时警告降级） */
    FFMPEG_GPU?: string;

    // ---- PySceneDetect 场景切分 ----
    /** 独立 scenedetect 服务地址；未配置即视为未启用。dev http://127.0.0.1:39040 / prod http://scenedetect-server:8000 */
    SCENEDETECT_BASE_URL?: string;
    /** 服务鉴权 token，需与 services/scenedetect/.env 的 SCENEDETECT_API_TOKEN 一致 */
    SCENEDETECT_API_TOKEN?: string;
    /** 缺省检测算法：content / adaptive / threshold。默认 content */
    SCENEDETECT_DETECTOR?: string;

    // ---- AI 检测（视频场景切分，src/aiDetect） ----
    /** 总开关：false 时提交接口返回 503、调度器不启动。默认 true */
    AI_DETECT_ENABLED?: string;
    /** 源视频上限（字节）：整份上传的传输上限 + 业务上限 + 分片合并上限。默认 2684354560（2.5GB，与素材库同量级） */
    AI_DETECT_MAX_VIDEO_BYTES?: string;
    /** 单个分片大小上限（字节），同时是分片路由 multer 的传输上限。默认 16777216（16MB） */
    AI_DETECT_CHUNK_MAX_CHUNK_BYTES?: string;
    /** 分片数上限，防止 totalChunks 被填成天文数字。默认 10000 */
    AI_DETECT_CHUNK_MAX_CHUNKS?: string;
    /** 未完成分片会话的存活时长（ms），新建会话时清理超期目录。默认 86400000（24h） */
    AI_DETECT_CHUNK_SESSION_TTL_MS?: string;
    /** 缺省检测算法：content / adaptive / threshold。默认 content */
    AI_DETECT_DEFAULT_DETECTOR?: string;
    /** 首尾黑帧检测：黑场最短时长（秒，ffmpeg d=）。默认 1 */
    AI_DETECT_BLACK_MIN_DURATION_SEC?: string;
    /** 首尾黑帧检测：整帧判黑所需的判黑像素比例下限（pic_th，0..1）。默认 0.98 */
    AI_DETECT_BLACK_PIC_TH?: string;
    /** 首尾黑帧检测：单像素判黑的亮度阈值（pix_th，相对满量程 0..1）。默认 0.1 */
    AI_DETECT_BLACK_PIX_TH?: string;
    /** URL 入参允许下载的最大字节数。默认 209715200（200MB） */
    AI_DETECT_URL_MAX_BYTES?: string;
    /** URL 入参下载总超时（ms），覆盖全部重定向跳数。默认 120000 */
    AI_DETECT_URL_TIMEOUT_MS?: string;
    /** URL 入参最大重定向跳数（每跳都重新做内网地址校验）。默认 5 */
    AI_DETECT_URL_MAX_REDIRECTS?: string;
    /** 调度 tick 间隔（ms）。默认 3000 */
    AI_DETECT_POLL_INTERVAL_MS?: string;
    /** **场景切分队列**的在途任务数上限（CPU 逐帧分析，0/负值/非数字按 1 处理）。默认 1 */
    AI_DETECT_CONCURRENCY?: string;
    /** 进度写库最小间隔（ms）。默认 1000 */
    AI_DETECT_PROGRESS_MIN_INTERVAL_MS?: string;
    /** leader 租约 TTL（ms），续期周期为 TTL/2。默认 60000 */
    AI_DETECT_LEASE_TTL_MS?: string;
    /** 调度器 leader 租约键。默认 wxbot:aidetect:leader */
    AI_DETECT_LEADER_KEY?: string;
    /** 陈旧任务判定阈值（ms），须大于一次最长检测耗时。默认 1800000（30 分钟） */
    AI_DETECT_TASK_STALE_MS?: string;
    /** 单帧抽帧子进程超时（ms）。默认 30000 */
    AI_DETECT_FRAME_EXTRACT_TIMEOUT_MS?: string;
    /** 抽帧 jpg 质量（ffmpeg -q:v，2..31，越小越好）。默认 3 */
    AI_DETECT_FRAME_JPEG_QUALITY?: string;
    /** **抽帧队列**的在途任务数上限，与 AI_DETECT_CONCURRENCY 互相独立（0/负值/非数字按 1 处理）。默认 1 */
    AI_DETECT_FRAME_CONCURRENCY?: string;
    /** **转写队列**的在途任务数上限，与另两条队列互相独立（0/负值/非数字按 1 处理）。默认 1 */
    AI_DETECT_ASR_CONCURRENCY?: string;
    /** 转写的音频切块时长（ms）。须保证 `chunkMs/1000 × 32KB ≤ ASR_MAX_AUDIO_BYTES`。默认 600000（10 分钟） */
    AI_DETECT_ASR_CHUNK_MS?: string;
    /** 单块音频提取子进程超时（ms）。默认 300000 */
    AI_DETECT_ASR_EXTRACT_TIMEOUT_MS?: string;
    /** 等待单个块转写完成的上限（ms），须 ≥ SUBTITLE_TASK_STALE_MS。默认 1800000（30 分钟） */
    AI_DETECT_ASR_SUBTITLE_TIMEOUT_MS?: string;

    // ---- 图片理解（Qwen3-VL，src/vlm / services/vlm） ----
    /** 客户端运行模式：`remote`=调用独立部署的 GPU 容器；`off`=禁用（默认）。需同时设 VLM_BASE_URL */
    VLM_MODE?: string;
    /** 远端 GPU 容器地址（仅 remote 模式使用）。开发机回环 http://127.0.0.1:39030；生产容器内 http://vlm-server:8000 */
    VLM_BASE_URL?: string;
    /** 远端服务鉴权 token，需与容器侧 VLM_API_TOKEN 一致 */
    VLM_API_TOKEN?: string;
    /** 模块总开关：false 时提交接口返回 503、调度器不启动。默认 true */
    VLM_ENABLED?: string;
    /** 源图片上限（字节），同时是上传路由 multer 的传输上限与业务上限。默认 20971520（20MB） */
    VLM_MAX_IMAGE_BYTES?: string;
    /** mode=json 的默认指令；留空用 utils/constant/vlm.ts 的 VLM_DEFAULT_PROMPT（便于不开代码调措辞） */
    VLM_DEFAULT_PROMPT?: string;
    /** mode=text 的默认指令；留空用 utils/constant/vlm.ts 的 VLM_DEFAULT_TEXT_PROMPT */
    VLM_DEFAULT_TEXT_PROMPT?: string;
    /** 任务状态轮询间隔（ms），也是 429 退避基数。默认 1500 */
    VLM_POLL_INTERVAL_MS?: string;
    /** 就绪等待 / 探活超时（ms）。默认 600000 */
    VLM_READY_TIMEOUT_MS?: string;
    /** 单个理解任务超时（ms），含容器冷启动加载模型。默认 600000 */
    VLM_JOB_TIMEOUT_MS?: string;
    /** 调度 tick 间隔（ms）。默认 3000 */
    VLM_DISPATCH_POLL_INTERVAL_MS?: string;
    /** 在途任务数上限（容器侧 GPU 并发恒为 1，0/负值/非数字按 1 处理）。默认 1 */
    VLM_CONCURRENCY?: string;
    /** 进度写库最小间隔（ms）。默认 1000 */
    VLM_PROGRESS_MIN_INTERVAL_MS?: string;
    /** leader 租约 TTL（ms），续期周期为 TTL/2。默认 60000 */
    VLM_LEASE_TTL_MS?: string;
    /** 调度器 leader 租约键。默认 wxbot:vlm:leader */
    VLM_LEADER_KEY?: string;
    /** 陈旧任务判定阈值（ms），须大于「容器冷加载 + 单图推理」。默认 1800000（30 分钟） */
    VLM_TASK_STALE_MS?: string;

    // ---- IndexTTS2 音色克隆（voiceTrainV2） ----
    /**
     * 运行模式：`remote`=调用独立部署的 GPU 服务容器；`local`=本机 spawn Python worker；
     * `off`=禁用。未设置时按「配了 INDEXTTS_BASE_URL 就是 remote」推断。
     */
    INDEXTTS_MODE?: string;
    /** 远端 GPU 服务地址（仅 remote 模式使用）。默认 http://127.0.0.1:39010 */
    INDEXTTS_BASE_URL?: string;
    /** 远端服务鉴权 token，需与容器侧 INDEXTTS_API_TOKEN 一致 */
    INDEXTTS_API_TOKEN?: string;
    /** 移植过来的桥接脚本目录。默认 ./services/indextts */
    INDEXTTS_ENGINE_DIR?: string;
    /** 运行期目录（JSON 配置 + 合成临时产物）。默认 ./.runtime/indextts */
    INDEXTTS_RUNTIME_DIR?: string;
    /** 冷启动超时 ms（首次加载模型 1-3 分钟，勿调小）。默认 600000 */
    INDEXTTS_READY_TIMEOUT_MS?: string;
    /** 连续崩溃次数上限，超过则回退一次性子进程。默认 3 */
    INDEXTTS_WORKER_MAX_CRASHES?: string;
    /** dispatcher 轮询间隔 ms。默认 1500 */
    INDEXTTS_POLL_INTERVAL_MS?: string;
    /** leader 租约 TTL ms，全机只允许一个热模型。默认 60000 */
    INDEXTTS_LEASE_TTL_MS?: string;
    /** 进度写库最小间隔 ms（worker 发 marker 远快于 UI 需要）。默认 1000 */
    INDEXTTS_PROGRESS_MIN_INTERVAL_MS?: string;

    // ---- 进程模型（node:cluster） ----
    /** worker 数：'auto'=CPU 核数；数字≥2=对应 worker 数；未设置/1=单进程（开发默认不设） */
    CLUSTER_WORKERS?: string;

    // ---- OAuth 授权服务器 ----
    /** 服务器公网可达的基础 URL（仅 origin，不含路径）；非 localhost 必须 https */
    SERVER_URL: string;

    // ---- 微信公众号 ----
    /** 公众号 AppID（凭证已迁移到 wxAccounts 集合按用户存储，保留用于兼容/签名校验） */
    WX_APPID?: string;
    WX_AppSecret?: string;
    WX_EncodingAESKey?: string;
    /** 公众号服务器签名校验 token（GET /hip/wx 回调仍使用） */
    WX_TOKEN?: string;

    // ---- 数字人（HeyGem/Duix 对口型） ----
    /** duix/HeyGem HTTP 服务地址。默认 http://127.0.0.1:8383 */
    HEYGEM_BASE_URL?: string;
    /** Node 可见的共享挂载目录（须与 duix 容器挂载的宿主机目录一致）。默认 ./data/heygem_face2face */
    HEYGEM_MOUNT_DIR?: string;
    /** duix 容器内对应挂载目录的前缀。默认 /code/data */
    HEYGEM_CONTAINER_PREFIX?: string;
    /** duix 健康探测超时（ms）。默认 3000 */
    HEYGEM_HEALTH_TIMEOUT_MS?: string;
    /** 调度器 leader 租约键。默认 wxbot:digitalhuman:leader */
    DIGITALHUMAN_LEADER_KEY?: string;

    // ---- 字幕生成（音频 → SRT） ----
    /** 字幕调度器 leader 租约键。默认 wxbot:subtitle:leader */
    SUBTITLE_LEADER_KEY?: string;

    // ---- 本地 Whisper（ASR 优先通道；外部 HTTP 服务，本项目不自带） ----
    /** Whisper 服务地址；设置且 mode=remote 才启用。默认空 */
    WHISPER_BASE_URL?: string;
    /** Whisper 服务鉴权 token，需与服务端一致。默认空 */
    WHISPER_API_TOKEN?: string;

    // ---- RSA 密码解密 ----
    /** 私钥 PEM 文件路径（相对 process.cwd()；默认 ./keys/rsa_private.pem） */
    RSA_PRIVATE_KEY_PATH?: string;
  }
}
