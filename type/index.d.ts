/** 邮件服务（Nodemailer SMTP）类型声明 */
export namespace Mailer {
  /** 邮件附件：path（本地文件）/ content（内容）/ href（远程 URL）三选一 */
  interface Attachment {
    filename: string;
    path?: string;
    content?: string;
    contentType?: string;
  }

  /** 发信入参（POST /api/mailer/send 请求体） */
  interface SendMailDto {
    /** 收件人（单个或多个） */
    to: string | string[];
    /** 主题 */
    subject: string;
    /** 纯文本正文（与 html 至少一个） */
    text?: string;
    /** HTML 正文（与 text 至少一个） */
    html?: string;
    /** 抄送 */
    cc?: string | string[];
    /** 密送 */
    bcc?: string | string[];
    /** 回复地址 */
    replyTo?: string;
    /** 发件人（缺省用 MAILER_FROM，再回退 MAILER_USER） */
    from?: string;
    /** 附件 */
    attachments?: Attachment[];
  }

  /** 发信结果（POST /api/mailer/send 响应 data） */
  interface SendResult {
    /** 服务端分配的邮件 id */
    messageId: string;
    /** 被接受的收件人 */
    accepted: string[];
    /** 被拒绝的收件人 */
    rejected: string[];
    /** SMTP 服务端原始响应，排障用 */
    response: string;
  }

  /** 邮件服务状态（GET /api/mailer/status 响应 data） */
  interface Status {
    /** 总开关（MAILER_ENABLED） */
    enabled: boolean;
    /** 是否配齐 HOST/USER */
    configured: boolean;
    host: string;
    port: number;
    /** 是否使用 TLS（MAILER_SECURE） */
    secure: boolean;
    /** 生效的发件人地址 */
    from: string;
  }
}

/** AI 平台（commandcode / deepseek 等 OpenAI 兼容平台）类型声明 */
export namespace AIPlatform {
  /** 平台标识（接入新平台时在此扩展） */
  type Provider = 'commandcode' | 'deepseek';

  /** 配置启用状态 */
  type AccountStatus = 'active' | 'disabled';

  /** 对话消息角色 */
  type ChatRole = 'system' | 'user' | 'assistant';

  /** 助手消息落库状态：success 正常 / failed 上游报错（保留已生成内容） */
  type MessageStatus = 'success' | 'failed';

  /** 平台支持的模型（GET /hip/api/cmdc/models 响应 data 元素，已简化字段） */
  interface Model {
    /** 模型 id（调用时使用） */
    id: string;
    /** 展示名称（缺省回退 id） */
    name: string;
    /** 上下文长度（token，缺省 0） */
    contextLength: number;
  }

  /** 平台预设（GET /hip/api/aiPlatforms/providers 响应 data.list 元素） */
  interface ProviderPreset {
    /** 平台标识 */
    key: Provider;
    /** 展示名称 */
    label: string;
    /** 默认 baseUrl（配置未显式覆盖时使用） */
    baseUrl: string;
    /** 预设模型（commandcode 为动态拉取结果，deepseek 为固定清单） */
    presetModels: Model[];
  }

  /** 创建平台配置入参 */
  interface AccountCreateData {
    /** 归属用户 id */
    userId: string;
    /** 配置名称 */
    name: string;
    /** 平台标识 */
    provider: Provider;
    /** 平台 API Key（明文入库，与项目现状一致） */
    apiKey: string;
    /** 自定义 baseUrl，留空使用平台预设 */
    baseUrl?: string;
    /** 默认模型 id */
    defaultModel: string;
    /** 启用/停用 */
    status?: AccountStatus;
  }

  /** 更新平台配置入参（全部可选；apiKey 不必全量重传） */
  interface AccountUpdateData {
    name?: string;
    provider?: Provider;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    status?: AccountStatus;
  }

  /** 平台配置分页查询参数（userId 恒为当前登录用户） */
  interface AccountQuery {
    userId: string;
    provider?: Provider;
    status?: AccountStatus;
    /** 匹配 name/defaultModel（正则，忽略大小写） */
    keyword?: string;
    page?: number;
    limit?: number;
  }

  /** 分页响应 */
  interface Page<T> {
    list: T[];
    total: number;
    page: number;
    limit: number;
  }

  /** 调用平台所需凭证（chatClient 消费） */
  interface Credential {
    provider: Provider;
    apiKey: string;
    /** 已解析的 baseUrl（配置覆盖或平台预设） */
    baseUrl: string;
  }

  /** 送入模型的消息 */
  interface ChatMessage {
    role: ChatRole;
    content: string;
  }

  /** 创建会话入参 */
  interface ConversationCreateData {
    /** 归属用户 id */
    userId: string;
    /** 引用的平台配置 id */
    accountId: string;
    /** 会话标题，缺省「新对话」 */
    title?: string;
    /** 系统提示词 */
    systemPrompt?: string;
    /** 指定模型，缺省取平台配置 defaultModel */
    model?: string;
  }

  /** 会话分页查询参数 */
  interface ConversationQuery {
    userId: string;
    accountId?: string;
    keyword?: string;
    page?: number;
    limit?: number;
  }

  /** 消息分页查询参数 */
  interface MessageQuery {
    userId: string;
    conversationId: string;
    page?: number;
    limit?: number;
  }

  /** 发起对话入参 */
  interface ChatRequest {
    /** 本轮用户输入 */
    content: string;
    /** 覆盖模型（缺省用会话模型） */
    model?: string;
  }
}

/** 用户业务类型声明 */

export namespace User {
  /** 用户角色：user 普通用户 / admin 管理员 */
  type Role = 'user' | 'admin' | 'sadmin';

  /** 用户资料（脱敏，不含密码） */
  interface Profile {
    id: string;
    account: string;
    nickname: string;
    avatar: string;
    role: User.Role;
    /** 父级用户 id（顶层用户为 null） */
    parentId: string | null;
    createdAt: Date;
  }

  /** 用户树节点：资料 + 递归 children（GET /api/users/children 响应 data.list 元素，全层级） */
  interface TreeNode extends User.Profile {
    /** 直接子用户，每个仍自带 children 向下递归 */
    children: User.TreeNode[];
  }

  /** 登录结果 */
  interface LoginResult {
    token: string;
    /** JWT 有效期（秒），用于对齐 cookie 过期时间 */
    expiresIn: number;
    user: User.Profile;
  }

  /** 分页查询参数（后代列表：恒为当前登录的 admin/sadmin 自己的子树） */
  interface Query {
    /** 模糊匹配 account/nickname */
    keyword?: string;
    page?: number;
    limit?: number;
  }

  /** 分页响应 */
  interface Page<T> {
    list: T[];
    total: number;
    page: number;
    limit: number;
  }

  /** 单日新增用户数（近半个月趋势的单个数据点） */
  interface DailyNewUsers {
    /** 自然日（本地时区，YYYY-MM-DD） */
    date: string;
    /** 当日新增用户数（无数据为 0） */
    count: number;
  }

  /** 用户数据统计（GET /hip/api/users/stats 响应 data，均只统计未删除用户） */
  interface Statistics {
    /** 用户总数 */
    total: number;
    /** 今日新注册用户数（本地时区当日 00:00 起，仅当天注册） */
    newToday: number;
    /** 按角色分组的用户数（含全部角色，无数据补 0） */
    byRole: Record<User.Role, number>;
    /** 近半个月每天新增用户数（按日期升序，含今日，无数据补 0） */
    dailyNew: User.DailyNewUsers[];
  }
}

/** UUID 签发登记管理类型声明 */
export namespace UuidManage {
  /** 签发状态：active 待消费 / used 已消费 / revoked 已吊销 */
  type Status = 'active' | 'used' | 'revoked';

  /** TTL 入参：秒数，'*' = 永不过期 */
  type Ttl = number | '*';

  /** 签发登记记录（对外返回形态，时间戳为毫秒） */
  interface Record {
    /** Mongo 主键，作为 CRUD 路由标识 */
    _id: string;
    userId: string;
    uuid: string;
    scene?: string;
    /** 会话名称 */
    name: string;
    status: UuidManage.Status;
    /** 签发 TTL（秒）；null = 永不过期 */
    ttl: number | null;
    /** 过期时间戳(ms)；null = 永不过期 */
    expireAt: number | null;
    /** 签发时间戳(ms) */
    issuedAt: number;
    /** 最近状态变更时间戳(ms) */
    updatedAt: number;
  }

  /** 创建 Session 入参（仓储层，时间戳为 Date） */
  interface CreateData {
    userId: string;
    uuid: string;
    scene?: string;
    name: string;
    status: UuidManage.Status;
    ttl: number | null;
    expireAt: Date | null;
  }

  /** 分页查询参数 */
  interface Query {
    userId?: string;
    status?: UuidManage.Status;
    scene?: string;
    name?: string;
    keyword?: string;
    /** 是否包含已过期 Session（默认 false，仅未过期） */
    includeExpired?: boolean;
    page?: number;
    limit?: number;
  }

  /** 分页响应 */
  interface Page<T> {
    list: T[];
    total: number;
    page: number;
    limit: number;
  }

  /** consume / revoke 的变更结果 */
  type MutationResult =
    | { ok: true; record: UuidManage.Record }
    | { ok: false; code: 'not_found' | 'not_active' | 'expired' };
}

/** 文件下载 MCP 工具返回类型 */
export namespace FileDownload {
  /** 按 fileId 获取文件下载地址的结果 */
  interface Result {
    fileId: string;
    originalName: string;
    mimeType: string;
    size: number;
    /** 文件下载真实地址（免 JWT，可直接访问） */
    url: string;
  }
}

/** 系统资源监控类型声明 */
export namespace System {
  /** CPU 信息 */
  interface Cpu {
    /** CPU 使用率（%），实时采样两次 os.cpus() 计算 */
    usagePercent: number;
    /** 逻辑核心数 */
    cores?: number;
    /** CPU 型号 */
    model?: string;
  }

  /** 内存信息（单位：字节） */
  interface Memory {
    total: number;
    used: number;
    free: number;
    /** 使用率（%） */
    percent: number;
  }

  /** 磁盘分区信息（单位：字节） */
  interface Disk {
    /** 设备/盘符（Linux: /dev/overlay，Windows: C:） */
    name: string;
    /** 挂载点/卷根（Linux: /，Windows: C:\） */
    mount: string;
    /** 文件系统类型（NTFS / overlay / ext4），未知时为 undefined */
    fsType?: string;
    total: number;
    used: number;
    free: number;
    /** 使用率（%） */
    usagePercent: number;
  }

  /** 进程内存信息（单位：字节） */
  interface ProcessMemory {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  }

  /** 进程/运行环境信息 */
  interface Process {
    nodeVersion: string;
    platform: string;
    arch: string;
    hostname: string;
    pid: number;
    /** 系统运行时长（秒） */
    systemUptime: number;
    /** 进程运行时长（秒） */
    uptime: number;
    /** 负载均值；Windows 下 os.loadavg() 恒为 [0,0,0] */
    loadAverage: number[];
    memory: System.ProcessMemory;
    cwd: string;
  }

  /** GPU 显存信息（单位：字节，与 Memory/Disk 一致） */
  interface GpuMemory {
    total: number;
    used: number;
    /** 使用率（%） */
    percent: number;
  }

  /** GPU 信息（NVIDIA nvidia-smi） */
  interface Gpu {
    /** GPU 型号（如 NVIDIA GeForce RTX 3090） */
    name: string;
    /** 计算资源占用率（%） */
    utilizationPercent: number;
    /** 温度（℃） */
    temperature: number;
    /** 显存占用 */
    memory: System.GpuMemory;
  }

  /** 系统资源总览（接口响应 data） */
  interface Resources {
    cpu: System.Cpu;
    memory: System.Memory;
    disk: System.Disk[];
    /** GPU 列表；无 GPU / nvidia-smi 不可用时为空数组 */
    gpu: System.Gpu[];
    process: Partial<System.Process>;
  }
}

/** 微信公众号配置类型声明 */
export namespace WxAccount {
  /** 公众号状态：active 启用 / disabled 停用 */
  type Status = 'active' | 'disabled';

  /** 创建入参（含归属用户 id） */
  interface CreateData {
    /** 归属用户 id */
    userId: string;
    /** 公众号名称 */
    name: string;
    /** 公众号 AppID */
    appId: string;
    /** 公众号 AppSecret（明文入库，与项目现状一致） */
    appSecret: string;
    /** 服务器配置 Token */
    token: string;
    /** 消息加解密密钥 */
    encodingAESKey: string;
    status?: WxAccount.Status;
  }

  /** 更新入参（全部可选；appSecret 更新可选，不必全量重传） */
  interface UpdateData {
    name?: string;
    appId?: string;
    appSecret?: string;
    token?: string;
    encodingAESKey?: string;
    status?: WxAccount.Status;
  }

  /** 分页查询参数（userId 恒为当前登录用户） */
  interface Query {
    userId: string;
    status?: WxAccount.Status;
    /** 匹配 name/appId（正则，忽略大小写） */
    keyword?: string;
    page?: number;
    limit?: number;
  }

  /** 分页响应 */
  interface Page<T> {
    list: T[];
    total: number;
    page: number;
    limit: number;
  }

  /** 调用微信 API 所需凭证（utils/wx/getToken 消费） */
  interface Credential {
    appId: string;
    appSecret: string;
    baseUrl: string;
  }
}

/** 抖音应用配置类型声明 */
export namespace DyAccount {
  /** 抖音应用状态：active 启用 / disabled 停用 */
  type Status = 'active' | 'disabled';

  /** 创建入参（含归属用户 id） */
  interface CreateData {
    /** 归属用户 id */
    userId: string;
    /** 应用名称 */
    name: string;
    /** 抖音开放平台 ClientKey */
    clientKey: string;
    /** 抖音开放平台 ClientSecret（明文入库，与项目现状一致） */
    clientSecret: string;
    status?: DyAccount.Status;
  }

  /** 更新入参（全部可选；clientSecret 更新可选，不必全量重传） */
  interface UpdateData {
    name?: string;
    clientKey?: string;
    clientSecret?: string;
    status?: DyAccount.Status;
  }

  /** 分页查询参数（userId 恒为当前登录用户） */
  interface Query {
    userId: string;
    status?: DyAccount.Status;
    /** 匹配 name/clientKey（正则，忽略大小写） */
    keyword?: string;
    page?: number;
    limit?: number;
  }

  /** 分页响应 */
  interface Page<T> {
    list: T[];
    total: number;
    page: number;
    limit: number;
  }

  /** 调用抖音 API 所需凭证（后续 utils/dy/getToken 消费） */
  interface Credential {
    clientKey: string;
    clientSecret: string;
    baseUrl: string;
  }
}

/** 音色训练 V2 类型声明 */
export namespace VoiceTrainV2 {
  // ---- 音色库（零样本克隆：参考音归一化存盘，合成时作为 spk_audio_prompt） ----

  /** 音色记录（落库形态，对外统一用 id 而非 _id；上传素材与音色同属一条记录） */
  interface VoiceRecord {
    id: string;
    /** 音色名称（同一用户内唯一） */
    resourceName: string;
    /** 上传素材的原始文件名 */
    sourceOriginalName: string;
    /** 上传素材大小（字节） */
    sourceSize: number;
    /** 上传素材 MIME 类型 */
    sourceMimeType: string;
    /** 上传素材时长（秒），恒 >= 10 */
    sourceDuration: number;
    /** 归一化 reference.wav 的 file 记录主键 */
    referenceFileId: string;
    /** reference.wav 的下载地址（免 JWT 的 /api/files/:id/download）。注意是原始参考音，非克隆试听效果 */
    referenceUrl: string;
    /** reference.wav 时长（秒） */
    referenceDuration: number;
    /** 参考音对应文本（仅元数据） */
    promptText: string;
    /** 合成后端，当前固定 indextts */
    backend: string;
    /** 参考音采样率，固定 22050 */
    sampleRate: number;
    /** 最近一次成功合成的试听产物 file 记录主键，未生成时为空串 */
    previewFileId: string;
    /** 试听地址（免 JWT 的 /api/files/:id/download），未生成时为空串 */
    previewUrl: string;
    /** 生成该试听所用文本 */
    previewText: string;
    /** 试听音频时长（秒） */
    previewDuration: number;
    /** 试听最近生成时间，未生成时缺省 */
    previewAt?: Date;
    userId: string;
    createdAt: Date;
    updatedAt: Date;
  }

  /** 上传训练音频并创建音色的入参（音频文件本身走 multipart，不在此结构内） */
  interface CreateVoiceUploadDto {
    /** 音色名称，必填，同一用户内唯一 */
    resourceName: string;
    /** 参考音对应文本，可选 */
    promptText?: string;
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /** 分页查询音色的入参（userId 精确 + resourceName 模糊，均为可选） */
  interface VoiceQuery {
    userId?: string;
    resourceName?: string;
    page?: number;
    limit?: number;
  }

  // ---- 合成任务 ----

  /** 合成任务状态（cancelled 仅排队中可取消，running/终态不可取消） */
  type SynthesisStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

  /**
   * 合成任务用途：preview 试听 / synthesis 正式合成。
   *
   * 同一条合成链路既用于「听听这个音色像不像」，也用于正式内容合成。只有 preview 成功后会把
   * 结果回写到音色的试听字段（previewUrl 等），synthesis 不回写 —— 否则正式合成会覆盖试听。
   */
  type SynthesisPurpose = 'preview' | 'synthesis';

  /** 合成任务（落库形态） */
  interface SynthesisTaskRecord {
    id: string;
    status: SynthesisStatus;
    /** 音色库记录主键 */
    voiceId: string;
    /** 待合成文本 */
    text: string;
    /** 速度档位：fast / balanced / quality */
    speedMode: string;
    /** 任务用途：preview 试听 / synthesis 正式合成 */
    purpose: SynthesisPurpose;
    /** 进度 0..1 */
    progress: number;
    /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
    stage: string;
    /** 该阶段的中文描述（服务端已映射好，便于前端直接展示） */
    stageLabel: string;
    /** 人类可读描述 / 失败原因 */
    message: string;
    /** 产出音频时长（秒） */
    duration: number;
    /** 试听地址，仅 success 时非空 */
    resultUrl: string;
    /** 产出音频的 file 记录主键，仅 success 时非空 */
    resultFileId: string;
    startedAt?: Date;
    finishedAt?: Date;
    userId: string;
    createdAt: Date;
    updatedAt: Date;
  }

  /**
   * 合成任务排队位置（全局 FIFO 口径，与 dispatcher 的领取顺序一致）。
   *
   * 队列顺序由 claimNextPending 的 createdAt 升序决定，因此位置是查询瞬间的快照：count 与领取
   * 并非原子，返回值会随调度推进而变化（position 只会变小）。
   */
  interface SynthesisTaskQueuePosition {
    taskId: string;
    status: SynthesisStatus;
    /** 待处理队列中的位次，1 = 下一个被领取；非 pending 时为 null */
    position: number | null;
    /** 前方还需跑完的任务数（含正在执行的那条），比 position 更贴近真实等待；非 pending 时为 0 */
    waitingAhead: number;
    /** 全局待处理任务数，与 GET /engine/status 的 queueDepth 同口径 */
    queueDepth: number;
    /** 当前正在执行的任务数（并发度恒为 1） */
    running: number;
  }

  /**
   * 音色合成任务队列计数（全局口径，跨 worker 一致）。
   *
   * pending/running 取自 Mongo（只统计 flag=1 的记录），total = pending + running，即
   * 「当前仍在排队或正在执行」的任务数；与 videoPipelineV2 / subtitle / digitalHuman 的
   * queue/status 同口径，供队列看板直接展示积压与在跑数量。
   */
  interface SynthesisQueueStatus {
    /** 任务总数（= pending + running） */
    total: number;
    /** 等待中任务数（status=pending，尚未被 dispatcher 领取） */
    pending: number;
    /** 运行中任务数（status=running，并发度恒为 1） */
    running: number;
  }

  /** 提交合成任务的返回 */
  interface SynthesizeAccepted {
    taskId: string;
    status: SynthesisStatus;
  }

  /** 提交合成任务的入参 */
  interface SynthesizeDto {
    /** 音色库记录主键 */
    voiceId: string;
    /** 待合成文本，缺省用默认试听文案 */
    text?: string;
    /** 速度档位，缺省 balanced */
    speedMode?: string;
    /** 任务用途，缺省 synthesis（正式合成，不回写试听）。试听请显式传 preview */
    purpose?: SynthesisPurpose;
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /** 分页查询合成任务的入参 */
  interface SynthesisTaskQuery {
    status?: SynthesisStatus;
    page?: number;
    limit?: number;
  }

  /**
   * IndexTTS 引擎状态（GPU 指标请另行调用 /api/system/resources）。
   *
   * 注意：本响应来自**回答该请求的那个 cluster worker**，是进程内视角。模型与 leader 租约
   * 全机只有一份，因此非 leader 进程会如实返回 leader=false / workerReady=false。
   * 用 workerId 可区分「换了进程」与「状态真的变了」；queueDepth 来自 Mongo，是全局口径。
   */
  interface EngineStatus {
    /** 回答本次请求的 cluster worker 标识（primary / 数字） */
    workerId: string;
    /** 总开关（INDEXTTS_ENABLED） */
    enabled: boolean;
    /** 运行模式：remote=调用独立 GPU 服务；local=本机 spawn；off=禁用 */
    mode: 'remote' | 'local' | 'off';
    /** 是否使用常驻 worker（仅 local 模式有意义） */
    workerEnabled: boolean;
    /** 本进程的 worker 是否已加载模型可接任务 */
    workerReady: boolean;
    /** 本进程是否持有 leader 租约（全机只有一个进程会返回 true） */
    leader: boolean;
    /** 本进程是否因反复崩溃被判定不可用 */
    healthy: boolean;
    /** 本进程的 worker 进程 pid；remote 模式下恒为 null（进程不在本进程树下） */
    workerPid: number | null;
    /** 待处理任务数（全局，来自 Mongo） */
    queueDepth: number;
    /** 本进程最近一次合成进度 */
    lastProgress: { pct: number; stage: string } | null;
    /** 引擎侧观测信息；remote 时来自远端 GET /api/v1/status */
    engine: {
      kind: 'local' | 'remote';
      /** remote 模式的推理服务地址 */
      baseUrl?: string;
      /** 引擎侧模型是否已就绪 */
      modelReady: boolean;
      /** 是否正在加载（冷启动 1–3 分钟） */
      loading?: boolean;
      /** 远端进程内模型加载次数；>1 说明发生了并发加载（例如误设 uvicorn --workers 2） */
      loadCount?: number;
      /** 远端服务自身队列的待跑任务数 */
      remoteQueueDepth?: number;
      /** 显存占用（remote 模式下由远端上报，本机取不到时为 null） */
      gpu?: { name: string; memUsedMiB: number; memTotalMiB: number } | null;
      /** 最近一次探测失败的原因 */
      error?: string;
    };
  }
}

export namespace DigitalHuman {
  // ---- 形象库（参考视频，供 HeyGem 换脸/对口型复用） ----

  /** 数字人形象记录（落库形态，对外统一用 id 而非 _id） */
  interface AvatarRecord {
    id: string;
    /** 形象名称（同一用户内唯一） */
    name: string;
    /** 上传素材的原始文件名 */
    sourceOriginalName: string;
    /** 上传素材大小（字节） */
    sourceSize: number;
    /** 上传素材 MIME 类型 */
    sourceMimeType: string;
    /** 上传素材时长（秒），恒在 5–45 之间 */
    sourceDuration: number;
    /** 归一化后参考视频的 file 记录主键 */
    referenceFileId: string;
    /** 参考视频下载地址（免 JWT 的 /api/files/:id/download） */
    referenceUrl: string;
    /** 归一化后参考视频时长（秒） */
    referenceDuration: number;
    /** 推理后端，当前固定 heygem */
    backend: string;
    userId: string;
    createdAt: Date;
    updatedAt: Date;
  }

  /** 创建形象的入参（视频文件本身走 multipart，不在此结构内） */
  interface CreateAvatarDto {
    /** 形象名称，必填，同一用户内唯一 */
    name: string;
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /** 分页查询形象的入参 */
  interface AvatarQuery {
    userId?: string;
    /** 形象名称模糊匹配 */
    name?: string;
    page?: number;
    limit?: number;
  }

  // ---- 数字人合成任务 ----

  /** 任务状态（cancelled 仅排队中可取消，running/终态不可取消） */
  type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

  /** 数字人合成任务（落库形态） */
  interface TaskRecord {
    id: string;
    status: TaskStatus;
    /** 形象库记录主键 */
    avatarId: string;
    /** 音色库记录主键（用于文本配音） */
    voiceId: string;
    /** 驱动文案 */
    text: string;
    /** 配音速度档位：fast / balanced / quality */
    speedMode: string;
    /** 进度 0..1 */
    progress: number;
    /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
    stage: string;
    /** 该阶段的中文描述 */
    stageLabel: string;
    /** 人类可读描述 / 失败原因 */
    message: string;
    /** 复用的 IndexTTS 配音任务主键 */
    audioTaskId: string;
    /** 配音产物 file 记录主键 */
    audioFileId: string;
    /** 配音产物下载地址 */
    audioUrl: string;
    /** 配音音频时长（秒） */
    audioDuration: number;
    /** 成片下载地址，仅 success 时非空；开启烧录时为带字幕的版本 */
    resultUrl: string;
    /** 成片 file 记录主键，仅 success 时非空 */
    resultFileId: string;
    /** 成片时长（秒） */
    videoDuration: number;
    /** 是否开启字幕烧录 */
    burnSubtitles: boolean;
    /** 复用的字幕生成任务主键，未开启烧录时为空 */
    subtitleTaskId: string;
    /** 烧录用字幕的 file 记录主键，仅开启烧录且成功时非空 */
    srtFileId: string;
    /** 字幕下载地址，仅开启烧录且成功时非空 */
    srtUrl: string;
    /** 字幕条数，未开启烧录时为 0 */
    cueCount: number;
    /** 烧录前原始成片的 file 记录主键，仅开启烧录时非空 */
    rawVideoFileId: string;
    /** 烧录前原始成片下载地址，仅开启烧录时非空 */
    rawVideoUrl: string;
    startedAt?: Date;
    finishedAt?: Date;
    userId: string;
    createdAt: Date;
    updatedAt: Date;
  }

  /** 字幕烧录样式（全部可选，缺省由服务端默认值兜底） */
  interface SubtitleBurnOptions {
    /** 字号（像素，按成片分辨率渲染） */
    fontSize?: number;
    /** 字体名 */
    fontName?: string;
    /** 文字颜色 #RRGGBB */
    colorHex?: string;
    /** 描边宽度 */
    outline?: number;
    /** 垂直位置：bottom 底部 / top 顶部 */
    position?: 'bottom' | 'top';
    /** 距上/下边缘的边距（像素） */
    marginV?: number;
  }

  /** 提交数字人任务的入参 */
  interface SubmitTaskDto {
    /** 形象库记录主键，必填 */
    avatarId: string;
    /** 音色库记录主键，必填 */
    voiceId: string;
    /** 驱动文案，必填 */
    text: string;
    /** 配音速度档位，缺省 balanced */
    speedMode?: string;
    /** 是否把字幕烧录进成片，缺省 false（不烧录，行为与历史一致） */
    burnSubtitles?: boolean;
    /** 烧录样式，仅 burnSubtitles=true 时生效 */
    subtitleOptions?: SubtitleBurnOptions;
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /**
   * 提交数字人任务的入参（复用已有字幕任务，不重跑 ASR）。
   *
   * 与 SubmitTaskDto 的差异：字幕来自调用方指定的字幕任务（其已生成的 SRT 会被直接烧录），
   * 而不是对本次合成的配音音频跑 ASR。配音仍由服务端用 voiceId + text 合成。
   */
  interface SubmitWithSubtitleTaskDto {
    /** 驱动文案，必填（用于合成配音） */
    text: string;
    /** 形象库记录主键，必填 */
    avatarId: string;
    /** 音色库记录主键，必填 */
    voiceId: string;
    /** 复用的字幕任务主键，必填（其 SRT 产物会被直接烧录） */
    subtitleId: string;
    /** 烧录样式，缺省由服务端默认值兜底 */
    subtitleOptions?: SubtitleBurnOptions;
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /** 提交任务的返回 */
  interface TaskAccepted {
    taskId: string;
    status: TaskStatus;
  }

  /** 分页查询任务的入参 */
  interface TaskQuery {
    status?: TaskStatus;
    page?: number;
    limit?: number;
  }

  /** 任务排队位置（全局 FIFO 口径） */
  interface TaskQueuePosition {
    taskId: string;
    status: TaskStatus;
    /** 待处理队列中的位次，1 = 下一个被领取；非 pending 时为 null */
    position: number | null;
    /** 前方还需跑完的任务数（含正在执行的那条）；非 pending 时为 0 */
    waitingAhead: number;
    /** 全局待处理任务数 */
    queueDepth: number;
    /** 当前正在执行的任务数（上限为 DIGITALHUMAN_CONCURRENCY） */
    running: number;
  }

  /**
   * 数字人合成任务队列计数（全局口径，跨 worker 一致）。
   *
   * pending/running 取自 Mongo（只统计 flag=1 的记录），total = pending + running，即
   * 「当前仍在排队或正在执行」的任务数；与 videoPipelineV2 / voiceTrainV2 / subtitle 的
   * queue/status 同口径，供队列看板直接展示积压与在跑数量。
   */
  interface QueueStatus {
    /** 任务总数（= pending + running） */
    total: number;
    /** 等待中任务数（status=pending，尚未被 dispatcher 领取） */
    pending: number;
    /** 运行中任务数（status=running，正在执行对口型合成） */
    running: number;
  }

  /**
   * 数字人引擎状态（进程内视角，回答该请求的那个 cluster worker）。
   *
   * duix 服务与 GPU 均为全机单实例，因此只有 leader 进程会返回 leader=true；
   * mount 信息一并暴露 —— 挂载目录与容器不一致是头号故障源。
   */
  interface EngineStatus {
    workerId: string;
    enabled: boolean;
    leader: boolean;
    healthy: boolean;
    /** duix 服务地址 */
    baseUrl: string;
    /** duix 服务是否可达 */
    reachable: boolean;
    /** Node 可见的共享挂载目录 */
    mountDir: string;
    /** duix 容器内的对应前缀 */
    containerPrefix: string;
    /** 挂载目录是否可写 */
    mountWritable: boolean;
    /** 待处理任务数（全局，来自 Mongo） */
    queueDepth: number;
    /** 调度器并发上限（DIGITALHUMAN_CONCURRENCY，经规整后实际值） */
    concurrency: number;
    /** 本进程当前在途任务数 */
    activeCount: number;
    /** 本进程最近一次 HeyGem 阶段进度 */
    lastProgress: { pct: number; message: string } | null;
    /** 最近一次探测失败的原因 */
    error?: string;
  }
}

/** 字幕生成（音频 → SRT）类型声明 */
export namespace Subtitle {
  /** 任务状态（cancelled 仅排队中可取消，running/终态不可取消） */
  type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

  /** 提交口径：直接上传音频 / 引用已有 file 记录 */
  type SourceType = 'upload' | 'fileId';

  /** 源媒体类型：audio 直接上传音频 / video 上传视频后提取音频 */
  type SourceMediaType = 'audio' | 'video';

  /** 字幕任务（落库形态，对外统一用 id 而非 _id） */
  interface TaskRecord {
    id: string;
    status: TaskStatus;
    /** 提交口径（排障用） */
    sourceType: SourceType;
    /** 源媒体类型（音频 / 视频） */
    sourceMediaType: SourceMediaType;
    /** 源媒体 file 记录主键（视频任务为源视频） */
    audioFileId: string;
    /** 源媒体下载地址 */
    audioUrl: string;
    /** 源媒体原始文件名 */
    originalName: string;
    /** 识别语种 */
    language: string;
    /** 进度 0..1 */
    progress: number;
    /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
    stage: string;
    /** 该阶段的中文描述 */
    stageLabel: string;
    /** 人类可读描述 / 失败原因 */
    message: string;
    /** 实际生效的 ASR 通道：xunfei / whisper，成功前为空 */
    provider: string;
    /** 生成的字幕 file 记录主键，仅 success 时非空 */
    srtFileId: string;
    /** 字幕下载地址，仅 success 时非空 */
    srtUrl: string;
    /** 字幕条数 */
    cueCount: number;
    /** 源音频时长（秒） */
    audioDuration: number;
    startedAt?: Date;
    finishedAt?: Date;
    userId: string;
    createdAt: Date;
    updatedAt: Date;
  }

  /** 提交字幕任务的入参（音频文件走 multipart，或传 fileId，二者其一） */
  interface SubmitTaskDto {
    /** 源音频 file 记录主键（controller 由上传结果或请求体解析后填入） */
    fileId: string;
    /** 提交口径，由 controller 判定 */
    sourceType: SourceType;
    /** 识别语种，缺省用 ASR_LANGUAGE */
    language?: string;
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /** 提交任务的返回 */
  interface TaskAccepted {
    taskId: string;
    status: TaskStatus;
  }

  /**
   * 提交视频字幕任务的入参。
   *
   * 视频已在提交时用 ffmpeg 提取出音频并落临时目录，故这里传的是产物信息而非原始视频——
   * 提取出的音频不入 file 表（属于中间产物），只把相对路径记在任务上供 dispatcher 消费。
   */
  interface SubmitVideoTaskDto {
    /** 源视频 file 记录主键 */
    videoFileId: string;
    /** 提取出的临时音频在 uploads 下的相对路径，形如 .subtitle/<uuid>/audio.wav */
    extractedAudioPath: string;
    /** 源视频原始文件名，用于 SRT 命名 */
    originalName: string;
    /** 识别语种，缺省用 ASR_LANGUAGE */
    language?: string;
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /** 分页查询任务的入参 */
  interface TaskQuery {
    status?: TaskStatus;
    page?: number;
    limit?: number;
  }

  /** 任务排队位置（全局 FIFO 口径） */
  interface TaskQueuePosition {
    taskId: string;
    status: TaskStatus;
    /** 待处理队列中的位次，1 = 下一个被领取；非 pending 时为 null */
    position: number | null;
    /** 前方还需跑完的任务数（含正在执行的那条）；非 pending 时为 0 */
    waitingAhead: number;
    /** 全局待处理任务数 */
    queueDepth: number;
    /** 当前正在执行的任务数（上限为 SUBTITLE_CONCURRENCY） */
    running: number;
  }

  /**
   * 字幕任务队列计数（全局口径，跨 worker 一致）。
   *
   * pending/running 取自 Mongo（只统计 flag=1 的记录），total = pending + running，即
   * 「当前仍在排队或正在执行」的任务数；与 videoPipelineV2 / voiceTrainV2 / digitalHuman 的
   * queue/status 同口径，供队列看板直接展示积压与在跑数量。
   */
  interface QueueStatus {
    /** 任务总数（= pending + running） */
    total: number;
    /** 等待中任务数（status=pending，尚未被 dispatcher 领取） */
    pending: number;
    /** 运行中任务数（status=running，正在执行转写） */
    running: number;
  }

  /**
   * 字幕引擎状态（进程内视角，回答该请求的那个 cluster worker）。
   *
   * 转写是云端/外部 HTTP 调用，本机无 GPU 单实例约束，但调度循环同样用 leader 租约收敛。
   */
  interface EngineStatus {
    workerId: string;
    enabled: boolean;
    leader: boolean;
    /** 配置的通道选择：auto / xunfei / whisper */
    provider: string;
    /** 待处理任务数（全局，来自 Mongo） */
    queueDepth: number;
    /** 调度器并发上限（SUBTITLE_CONCURRENCY，经规整后实际值） */
    concurrency: number;
    /** 本进程当前在途任务数 */
    activeCount: number;
    /** 本地优先通道（Whisper）配置与可达性 */
    whisper: { enabled: boolean; baseUrl: string; reachable: boolean };
    /** 本进程最近一次转写进度 */
    lastProgress: { pct: number; stage: string } | null;
  }
}

/** 视频生成管道 V2（本地 IndexTTS 配音 + Whisper 字幕 → ffmpeg 烧录）类型声明 */
export namespace VideoPipelineV2 {
  /** 任务状态（cancelled 仅排队中可取消，running/终态不可取消） */
  type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

  /** 任务模式：pipeline 完整管道（配音 + 字幕 + 合成）；compose 纯合成（直接用已知音频 + 字幕产物） */
  type TaskMode = 'pipeline' | 'compose';

  /** 管道任务（落库形态，对外统一用 id 而非 _id） */
  interface TaskRecord {
    id: string;
    status: TaskStatus;
    /** 任务模式：pipeline / compose */
    mode: TaskMode;
    /** 待合成文本 */
    text: string;
    /** 音色库记录主键 */
    voiceId: string;
    /** 速度档位：fast / balanced / quality */
    speedMode: string;
    /** 背景色（色名或 #RRGGBB），缺省 black */
    color?: string;
    /** 每个字幕段落对应的 Pixabay 素材搜索词 */
    keywords: string[];
    /** 进度 0..1 */
    progress: number;
    /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
    stage: string;
    /** 该阶段的中文描述 */
    stageLabel: string;
    /** 人类可读描述 / 失败原因 */
    message: string;
    /** 复用的 IndexTTS 配音任务主键，未提交时为空 */
    voiceTaskId: string;
    /** 配音产物 file 记录主键，未完成时为空 */
    audioFileId: string;
    /** 配音产物下载地址，未完成时为空 */
    audioUrl: string;
    /** 配音音频时长（秒） */
    audioDuration: number;
    /** 复用的字幕任务主键，未提交时为空 */
    subtitleTaskId: string;
    /** 字幕 SRT 的 file 记录主键，未完成时为空 */
    srtFileId: string;
    /** 字幕下载地址，未完成时为空 */
    srtUrl: string;
    /** 字幕条数 */
    cueCount: number;
    /** 实际生效的 ASR 通道：xunfei / whisper，成功前为空 */
    provider: string;
    /** 成品视频 file 记录主键，仅 success 时非空 */
    videoFileId: string;
    /** 成品视频下载地址，仅 success 时非空 */
    videoUrl: string;
    /** 成品视频时长（秒） */
    videoDuration: number;
    startedAt?: Date;
    finishedAt?: Date;
    userId: string;
    createdAt: Date;
    updatedAt: Date;
  }

  /** 提交管道任务的入参（无文件上传，纯 JSON） */
  interface SubmitTaskDto {
    /** 音色库记录主键，必填 */
    voiceId: string;
    /** 待合成文本，必填 */
    text: string;
    /** 速度档位，缺省 balanced */
    speedMode?: string;
    /** 背景色（色名或 #RRGGBB），缺省 black */
    color?: string;
    /** 每个字幕段落对应的 Pixabay 素材搜索词 */
    keywords?: string[];
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /**
   * 提交「纯合成」任务的入参：直接用已知音频 + 字幕产物合成，不触发配音与字幕。
   * voiceId / text / speedMode 仅随任务落库记录，不参与生成。
   */
  interface SubmitComposeTaskDto {
    /** 已存在的音频文件主键（files._id），必填 */
    audioFileId: string;
    /** 已存在的字幕 SRT 文件主键（files._id），必填 */
    srtFileId: string;
    /** 每个字幕段落对应的 Pixabay 素材搜索词，缺省用 cue 文本清洗兜底 */
    keywords?: string[];
    /** 背景色（色名或 #RRGGBB），缺省 black */
    color?: string;
    /** 仅记录：音色库记录主键 */
    voiceId?: string;
    /** 仅记录：待合成文本 */
    text?: string;
    /** 仅记录：速度档位，缺省 balanced */
    speedMode?: string;
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /** 提交任务的返回 */
  interface TaskAccepted {
    taskId: string;
    status: TaskStatus;
  }

  /** 分页查询任务的入参 */
  interface TaskQuery {
    /** 任务模式过滤，缺省不过滤 */
    mode?: TaskMode;
    status?: TaskStatus;
    page?: number;
    limit?: number;
  }

  /** 任务排队位置（全局 FIFO 口径，与 dispatcher 的领取顺序一致） */
  interface TaskQueuePosition {
    taskId: string;
    status: TaskStatus;
    /** 待处理队列中的位次，1 = 下一个被领取；非 pending 时为 null */
    position: number | null;
    /** 前方还需跑完的任务数（含正在执行的那条）；非 pending 时为 0 */
    waitingAhead: number;
    /** 全局待处理任务数 */
    queueDepth: number;
    /** 当前正在执行的任务数（上限为 VIDEO_PIPELINE_V2_CONCURRENCY） */
    running: number;
  }

  /**
   * 视频合成任务队列计数（全局口径，跨 worker 一致）。
   *
   * pending/running 取自 Mongo（只统计 flag=1 的记录），total = pending + running，即
   * 「当前仍在排队或正在执行」的任务数；与 V1 的 GET /api/voiceTrain/task/pipeline/queue/status 同口径，
   * 区别只是不针对具体任务、也不要求归属，供队列看板直接展示积压与在跑数量。
   */
  interface QueueStatus {
    /** 任务总数（= pending + running） */
    total: number;
    /** 等待中任务数（status=pending，尚未被 dispatcher 领取） */
    pending: number;
    /** 运行中任务数（status=running，正在执行管道） */
    running: number;
  }

  /**
   * 管道引擎状态（进程内视角，回答该请求的那个 cluster worker）。
   *
   * 管道不持有 GPU 模型，配音/字幕分别由 voiceTrainV2 与 subtitle 的 leader dispatcher 执行；
   * 这里只报告两段通道的开关与本地 Whisper 可达性，便于确认接线是否生效。
   */
  interface EngineStatus {
    workerId: string;
    enabled: boolean;
    leader: boolean;
    /** 配音通道（IndexTTS） */
    voice: { enabled: boolean; mode: 'remote' | 'local' | 'off' };
    /** 字幕通道（ASR） */
    subtitle: {
      enabled: boolean;
      provider: string;
      whisper: { enabled: boolean; reachable: boolean };
    };
    /** 待处理任务数（全局，来自 Mongo） */
    queueDepth: number;
    /** 调度器并发上限（VIDEO_PIPELINE_V2_CONCURRENCY，经规整后实际值） */
    concurrency: number;
    /** 本进程当前在途任务数 */
    activeCount: number;
  }
}

/** RSA 密码解密类型声明 */
export namespace Rsa {
    /** 解密失败原因：invalid_cipher=密文不可解；key_unavailable=服务端私钥缺失或损坏 */
    type DecryptFailureReason = 'invalid_cipher' | 'key_unavailable';

    /** 解密结果：ok=false 时 reason 区分「客户端密文问题」与「服务端密钥问题」 */
    type DecryptResult =
        | { ok: true; plain: string }
        | { ok: false; reason: Rsa.DecryptFailureReason };
}

/** PySceneDetect 场景切分类型声明（utils/videoHelper/sceneDetect.ts） */
export namespace SceneDetect {
    /**
     * 检测算法：
     * - content 内容突变（通用默认，按 HSV 差分找硬切）
     * - adaptive 自适应（镜头运动多、光照渐变的素材更稳）
     * - threshold 亮度阈值（淡入淡出、纯黑白切换）
     */
    type Detector = 'content' | 'adaptive' | 'threshold';

    /** 单个场景区间（毫秒；与 SrtCue 一致，对外时间单位统一为 ms） */
    interface Scene {
        /** 序号，从 1 开始 */
        index: number;
        /** 场景起点（ms，含） */
        startMs: number;
        /** 场景终点（ms，不含） */
        endMs: number;
        /** 场景时长（ms，= endMs - startMs） */
        durationMs: number;
    }

    /**
     * 一段黑场（由 ffmpeg 的 blackdetect 滤镜检出）。
     *
     * 时间轴是**源视频全局 ms**（窗口扫描的相对时间已在解析时补回偏移），与 Scene 同一口径。
     * 注意它只是检出的原始区间，不含「贴头还是贴尾」这类业务判断 —— 后者由 aiDetectBlack.helper 决定。
     */
    interface BlackRange {
        /** 黑场起点（ms，含） */
        startMs: number;
        /** 黑场终点（ms，不含）；一直黑到扫描窗口末端时取窗口末端 */
        endMs: number;
        /** 黑场时长（ms，= endMs - startMs） */
        durationMs: number;
    }

    /** 检测入参（全部可选，缺省值见 services/scenedetect/README.md） */
    interface DetectOptions {
        /** 检测算法，缺省 content */
        detector?: Detector;
        /** 检测阈值，缺省用该算法的推荐值（content 27 / adaptive 3 / threshold 12） */
        threshold?: number;
        /** 最短场景时长（秒），缺省 0.6；小于该长度的切点会被合并 */
        minSceneLenSec?: number;
        /** 检测前降采样倍数（1=不降采样），缺省由 PySceneDetect 按分辨率自适应 */
        downscale?: number;
        /** 隔帧采样数（0=逐帧），越大越快越粗 */
        frameSkip?: number;
        /** 子进程超时（ms），缺省 SCENE_DETECT_TIMEOUT_MS */
        timeoutMs?: number;
    }

    /**
     * 独立 scenedetect 服务 `POST /api/v1/detect` 的请求体（见 services/scenedetect/README.md）。
     * 字段用 snake_case（Python 侧惯例）；未给的字段省略，交回检测脚本的缺省值。
     */
    interface DetectRequest {
        /** 输入视频绝对路径（须在 scenedetect 容器内可达） */
        input: string;
        /** 检测算法 */
        detector?: Detector;
        /** 检测阈值，缺省用该算法的推荐值 */
        threshold?: number;
        /** 最短场景时长（秒），缺省 0.6 */
        min_scene_len?: number;
        /** 检测前降采样倍数，缺省自适应 */
        downscale?: number;
        /** 隔帧采样数，缺省 0 */
        frame_skip?: number;
    }

    /** 检测结果（结果无缝覆盖整段视频，scenes 至少一段） */
    interface Result {
        /** PySceneDetect 版本号 */
        version: string;
        /** 实际生效的检测算法 */
        detector: Detector;
        /** 实际生效的阈值 */
        threshold: number;
        /** 实际生效的最短场景时长（秒） */
        minSceneLenSec: number;
        /** 视频帧率 */
        frameRate: number;
        /** 视频总时长（ms） */
        durationMs: number;
        /** 场景数（恒等于 scenes.length） */
        sceneCount: number;
        /** 场景区间列表（按时间升序，首段从 0 起、末段到视频结束） */
        scenes: Scene[];
    }
}

/** AI 检测（视频场景切分 / 场景抽帧）接口类型声明（src/aiDetect） */
export namespace AiDetect {
    /** 任务状态（cancelled 仅排队中可取消，running/终态不可取消） */
    type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

    /** 提交口径：上传文件 / 引用已有 file 记录 / 远程 URL 下载 */
    type SourceType = 'upload' | 'fileId' | 'url';

    /** 单场景抽取的三个帧位：开始帧 / 中间帧 / 结束帧（结束帧已回退两帧，见 resolveSceneFrameTimes） */
    type FrameKind = 'start' | 'mid' | 'end';

    /** 单张关键帧（kind 与时间点是抽帧口径，fileId 是登记进 file 表后的取用凭据） */
    interface Frame {
        /** 帧位 */
        kind: FrameKind;
        /** 实际抽帧时间点（ms，已保证落在该场景区间内） */
        timeMs: number;
        /** 帧图片在 file 表中的主键 */
        fileId: string;
        /** 帧图片下载地址，形如 /api/files/<id>/download */
        url: string;
    }

    /** 单个场景的抽帧产物（自带 startMs/endMs，使抽帧任务不依赖场景任务仍可自解释） */
    interface SceneFrames {
        /** 场景序号，对应源场景任务的 scenes[].index */
        index: number;
        /** 场景起点（ms，含） */
        startMs: number;
        /** 场景终点（ms，不含） */
        endMs: number;
        /** 实际抽到的帧（1..3 张：极短场景的中间帧/结束帧会与开始帧重合而被去重） */
        frames: Frame[];
    }

    /**
     * 检测参数（提交时可选）。
     *
     * 数值字段落库时 `0` 表示「未指定」—— 缺省阈值/最短场景时长由检测脚本按算法推荐值兜底
     * （content 27 / adaptive 3 / threshold 12，最短场景 0.6s），Node 侧不重复一份缺省表。
     */
    interface DetectOptions {
        /** 检测算法：content / adaptive / threshold */
        detector?: string;
        /** 检测阈值，缺省用该算法的推荐值 */
        threshold?: number;
        /** 最短场景时长（秒） */
        minSceneLenSec?: number;
        /** 检测前降采样倍数（1=不降采样） */
        downscale?: number;
        /** 隔帧采样数（0=逐帧） */
        frameSkip?: number;
        /**
         * 首尾黑帧检测的窗口时长（秒）：只扫描首、尾各这么长的时间段，把贴边的黑场另立为独立场景。
         * 未传或 ≤0 = 不做检测（落库同样记 0）；扫不到黑场即表示这段视频没有片头/片尾黑场。
         */
        blackDetectSec?: number;
    }

    /**
     * 首尾黑场被另立成的场景标记。
     *
     * 为什么不让 Scene 自己带 isBlack：SceneDetect.Scene 是检测引擎的产物、被各下游共用，
     * 塞进「业务语义上它是不是黑场」会让那个类型同时承担两种职责；这里用 sceneIndex 指回场景，
     * 前端按 marks 里的序号取即可。
     */
    interface BlackSceneMark {
        /** 贴着头还是尾 */
        position: 'head' | 'tail';
        /** 该黑场现在是第几个场景（1 起，与 scenes[].index 对应） */
        sceneIndex: number;
        /** 黑场起点（ms，含） */
        startMs: number;
        /** 黑场终点（ms，不含） */
        endMs: number;
        /** 黑场时长（ms，= endMs - startMs） */
        durationMs: number;
    }

    /**
     * 场景切分任务（落库形态，对外统一用 id 而非 _id）。
     *
     * 抽帧是另一个任务、另一张表（见 FrameTaskRecord）：`/scene/tasks/*` 只会返回本类型。
     */
    interface TaskRecord {
        id: string;
        status: TaskStatus;
        /** 提交口径（排障用） */
        sourceType: SourceType;
        /** 源视频 file 记录主键 */
        sourceFileId: string;
        /** 源视频下载地址，形如 /api/files/<id>/download */
        sourceUrl: string;
        /** 源视频原始文件名 */
        originalName: string;
        /** sourceType=url 时记录调用方传入的原始地址（排障用）；其余口径为空串 */
        remoteUrl: string;
        /** 实际生效的检测算法 */
        detector: SceneDetect.Detector;
        /** 检测阈值；0 = 未指定，由脚本用推荐值 */
        threshold: number;
        /** 最短场景时长（秒）；0 = 未指定 */
        minSceneLenSec: number;
        /** 降采样倍数；0 = 未指定（由 PySceneDetect 按分辨率自适应） */
        downscale: number;
        /** 隔帧采样数；0 = 逐帧 */
        frameSkip: number;
        /** 首尾黑帧检测窗口时长（秒）；0 = 未做检测（提交未传或 ≤0） */
        blackDetectSec: number;
        /**
         * 进度 0..1。
         * 注意是**粗粒度四档**（0.05 解析源视频 → 0.1 检测中 → 0.9 保存 → 1 完成）：
         * 检测是一次性子进程调用、不回报中间进度，详见 aiDetectDispatcher 的说明。
         */
        progress: number;
        /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
        stage: string;
        /** 该阶段的中文描述（服务端已映射好，便于前端直接展示） */
        stageLabel: string;
        /** 人类可读描述 / 失败原因 */
        message: string;
        /** 场景数（恒等于 scenes.length） */
        sceneCount: number;
        /** 源视频总时长（ms） */
        durationMs: number;
        /** 源视频帧率 */
        frameRate: number;
        /** 检测所用的 PySceneDetect 版本 */
        pySceneDetectVersion: string;
        /** 场景区间列表（无缝覆盖整段视频，至少一段；仅 success 时非空） */
        scenes: SceneDetect.Scene[];
        /**
         * 首尾黑场被另立成的场景标记（仅 success 时可能有值）。
         *
         * 空数组的语义分两种，靠 blackDetectSec 区分：blackDetectSec=0 表示没做这项检测；
         * >0 却是空数组则表示**做了检测、但首尾没有黑场**（即这段视频没有片头片尾黑屏）。
         */
        blackRanges: BlackSceneMark[];
        /** 该场景任务下的抽帧任务（仅分页列表内嵌；全量、createdAt 倒序） */
        frameTasks?: FrameTaskRecord[];
        /** 该场景任务下的转写任务（仅分页列表内嵌；全量、createdAt 倒序） */
        asrTasks?: AsrTaskRecord[];
        /** 该场景任务经其抽帧任务关联的批量图像识别任务（仅分页列表内嵌；全量、createdAt 倒序） */
        imageTasks?: VlmBatch.TaskRecord[];
        startedAt?: Date;
        finishedAt?: Date;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    }

    /**
     * 抽帧任务（落库形态）。
     *
     * 与 TaskRecord 的差别：入参是**已完成的场景切分任务**（sourceTaskId）而不是源视频，
     * 结果是一堆关键帧图片而不是场景时间段。源视频相关字段（sourceFileId/sourceUrl/originalName）
     * 与 sceneCount/durationMs/frameRate 都在建任务时从场景任务继承，使本记录自解释。
     *
     * 它在自己的集合（aiDetectFrameTasks）与自己的队列上执行：并发额度是 AI_DETECT_FRAME_CONCURRENCY，
     * 排队位次/队列计数/引擎状态都与场景切分互不影响。
     */
    interface FrameTaskRecord {
        id: string;
        status: TaskStatus;
        /** 来源场景切分任务 id（必须是 success 且 scenes 非空） */
        sourceTaskId: string;
        /** 源视频 file 记录主键（自场景任务继承） */
        sourceFileId: string;
        /** 源视频下载地址，形如 /api/files/<id>/download */
        sourceUrl: string;
        /** 源视频原始文件名（同时是帧文件名的词干） */
        originalName: string;
        /** 场景数（自场景任务继承，= 抽帧时纳入的场景总数） */
        sceneCount: number;
        /** 源视频总时长（ms，自场景任务继承） */
        durationMs: number;
        /**
         * 源视频帧率（自场景任务继承）。
         * 抽帧用它换算「结束帧回退一帧」的步长；为 0 时按 25fps 兜底。
         */
        frameRate: number;
        /**
         * 进度 0..1。
         * 与场景任务的粗粒度四档不同，这里是**真实百分比**：抽帧是逐场景的重复子进程调用，
         * 每完成一个场景就能推进一次（0.05 解析源视频 → 0.1~0.9 抽帧中 → 1 完成）。
         */
        progress: number;
        /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
        stage: string;
        /** 该阶段的中文描述（服务端已映射好，便于前端直接展示） */
        stageLabel: string;
        /** 人类可读描述 / 失败原因 */
        message: string;
        /** 实际抽到的帧总数（= Σ frames[].frames.length，≤ 3 × sceneCount） */
        frameCount: number;
        /** 每个场景的抽帧产物（仅 success 时非空，按场景序号升序） */
        frames: SceneFrames[];
        startedAt?: Date;
        finishedAt?: Date;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    }

    /** 提交抽帧任务的入参（唯一入参是场景切分任务 id） */
    interface SubmitFrameTaskDto {
        /** 已完成的场景切分任务 id */
        taskId: string;
        /** 归属用户，缺省回退 JWT */
        userId?: string;
    }

    /** 分页查询抽帧任务的入参（口径与 TaskQuery 一致） */
    type FrameTaskQuery = TaskQuery;

    /**
     * 一段识别出的文本。
     *
     * 时间轴是**源视频全局毫秒**（已按音频块起点偏移过），且是左闭右开 ——
     * 与 SceneDetect.Scene / SrtCue 同一口径，本仓库对外时间单位统一为 ms。
     */
    interface AsrSegment {
        /** 起点（ms，含） */
        startMs: number;
        /** 终点（ms，不含） */
        endMs: number;
        /** 识别文本 */
        text: string;
    }

    /** 单个场景的转写文本（按场景归组的那一份；该场景没有语音时 segments 为空数组） */
    interface AsrSceneSegments {
        /** 场景序号，对应源场景任务的 scenes[].index */
        index: number;
        /** 场景起点（ms，含） */
        startMs: number;
        /** 场景终点（ms，不含） */
        endMs: number;
        /** 归属本场景的文本段（按时间升序） */
        segments: AsrSegment[];
    }

    /** 一个音频块的处理记录（排障与复用凭据） */
    interface AsrChunk {
        /** 块序号，从 1 开始 */
        index: number;
        /** 块在源视频时间轴上的区间起点（ms，含） */
        startMs: number;
        /** 区间终点（ms，不含） */
        endMs: number;
        /** 块音频在 file 表中的记录 id */
        wavFileId: string;
        /** 块音频下载地址，形如 /api/files/<id>/download */
        wavUrl: string;
        /** 该块对应的字幕子任务 id（可据此查字幕任务详情） */
        subtitleTaskId: string;
        /** 该块识别出的文本段数 */
        cueCount: number;
    }

    /**
     * 转写任务（落库形态）。
     *
     * 入参是**已完成的场景切分任务**（sourceTaskId）；结果是一批文本段，而不是文件。
     * 转写本身跑在 subtitle 模块的队列上（本模块只切块、提子任务、轮询、归并），
     * 故它有自己的集合（aiDetectAsrTasks）与队列：并发额度是 AI_DETECT_ASR_CONCURRENCY，
     * 排队位次/队列计数/引擎状态都与另两条队列互不影响。
     */
    interface AsrTaskRecord {
        id: string;
        status: TaskStatus;
        /** 来源场景切分任务 id（必须 success 且 scenes 非空） */
        sourceTaskId: string;
        /** 源视频 file 记录主键（自场景任务继承） */
        sourceFileId: string;
        /** 源视频下载地址，形如 /api/files/<id>/download */
        sourceUrl: string;
        /** 源视频原始文件名 */
        originalName: string;
        /** 场景数（自场景任务继承） */
        sceneCount: number;
        /** 源视频总时长（ms，自场景任务继承；切块按它规划） */
        durationMs: number;
        /**
         * 进度 0..1。
         * 真实百分比：以音频块为推进单位（0.05 解析源视频 → 0.1~0.9 逐块转写 → 1 完成），
         * 块内等待转写期间会透传子任务的阶段文案。
         */
        progress: number;
        /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
        stage: string;
        /** 该阶段的中文描述 */
        stageLabel: string;
        /** 人类可读描述 / 失败原因；逐块执行时写「第 N/M 块」 */
        message: string;
        /** 实际生效的 ASR 通道（whisper / xunfei，取自字幕子任务） */
        provider: string;
        /** 文本段总数（= segments.length） */
        segmentCount: number;
        /** 全局时间轴的文本段（扁平，按时间升序；仅 success 时非空） */
        segments: AsrSegment[];
        /** 同一批文本段按场景归组（每个场景一份，可能为空数组） */
        sceneSegments: AsrSceneSegments[];
        /** 音频块的处理记录（按块升序） */
        chunks: AsrChunk[];
        startedAt?: Date;
        finishedAt?: Date;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    }

    /** 提交转写任务的入参（唯一入参是场景切分任务 id） */
    interface SubmitAsrTaskDto {
        /** 已完成的场景切分任务 id */
        taskId: string;
        /** 归属用户，缺省回退 JWT */
        userId?: string;
    }

    /** 分页查询转写任务的入参（口径与 TaskQuery 一致） */
    type AsrTaskQuery = TaskQuery;

    /**
     * 场景合并入参（POST /api/aiDetect/scene/tasks/:taskId/merge）。
     *
     * 同步接口：不建任务、不入队，但**会把结果写回来源任务** —— 该任务从此就是合并后的划分
     * （scenes/sceneCount 被覆盖，原划分不保留、不可撤销）。
     * 序号始终指任务**当前**的划分，故可反复调用（如先并 [4,5]，再并 [1,2]）。
     * 任务已有抽帧或转写任务时拒绝合并（409）。
     */
    interface MergeScenesDto {
        /**
         * 合并分组：每组 ≥ 2 个**连续**的场景序号，组内并成一个新场景；
         * 未出现在任何分组里的场景原样保留。如 [[1,2],[3,4,5]]。
         * 组内顺序不敏感（[4,3] 视同 [3,4]），但不允许跳号，也不允许同一序号出现在两个组里。
         */
        groups: number[][];
        /** 归属用户，缺省回退 JWT */
        userId?: string;
    }

    /** 场景合并结果（已写回来源任务，与任务当前 scenes 一致） */
    interface MergedScenesRecord {
        /** 来源场景切分任务 id（其 scenes/sceneCount 已被本次合并覆盖） */
        sourceTaskId: string;
        /** 合并后的场景列表，序号已从 1 连续重排，按时间升序，且同样无缝覆盖整段视频 */
        scenes: SceneDetect.Scene[];
        /** = scenes.length（= 来源任务更新后的 sceneCount） */
        sceneCount: number;
        /** 本次合并前的场景数（反复合并时是上一次的结果） */
        sourceSceneCount: number;
    }

    /** 提交任务的入参（controller 由上传结果 / 请求体解析后填入） */
    interface SubmitTaskDto extends DetectOptions {
        sourceType: SourceType;
        /** sourceType=fileId 时必填 */
        fileId?: string;
        /** sourceType=url 时必填 */
        url?: string;
        /** 归属用户，缺省回退 JWT */
        userId?: string;
    }

    /** 提交任务的返回 */
    interface TaskAccepted {
        taskId: string;
        status: TaskStatus;
    }

    /** 分页查询任务的入参 */
    interface TaskQuery {
        status?: TaskStatus;
        page?: number;
        limit?: number;
    }

    /** 任务排队位置（全局 FIFO 口径，与 dispatcher 的领取顺序一致） */
    interface TaskQueuePosition {
        taskId: string;
        status: TaskStatus;
        /** 待处理队列中的位次，1 = 下一个被领取；非 pending 时为 null */
        position: number | null;
        /** 前方还需跑完的任务数（含正在执行的那条）；非 pending 时为 0 */
        waitingAhead: number;
        /** 全局待处理任务数 */
        queueDepth: number;
        /** 当前正在执行的任务数（上限为 AI_DETECT_CONCURRENCY） */
        running: number;
    }

    /**
     * 队列计数（**单条队列**的口径，跨 worker 一致）。
     *
     * 场景切分与抽帧是两条独立队列，各有一套计数：场景侧看 `/scene/tasks/queue/status`，
     * 抽帧侧看 `/frames/tasks/queue/status`，互不包含。
     */
    interface QueueStatus {
        /** 任务总数（= pending + running） */
        total: number;
        /** 等待中任务数（status=pending，尚未被 dispatcher 领取） */
        pending: number;
        /** 运行中任务数（status=running，上限为所属队列的并发额度） */
        running: number;
    }

    /**
     * 引擎状态（进程内视角，回答该请求的那个 cluster worker）。
     *
     * 检测与抽帧都不持有 GPU 模型，本机无单实例约束；但调度循环同样用 leader 租约收敛，
     * 故只有 leader 进程会返回 leader=true。
     *
     * 调度器一个进程管两条队列，本结构按**单条队列**各报一份：场景侧看 `/scene/engine/status`
     * （并发额度 AI_DETECT_CONCURRENCY）、抽帧侧看 `/frames/engine/status`（AI_DETECT_FRAME_CONCURRENCY），
     * 两侧的 activeCount / lastProgress 各记各的。
     */
    interface EngineStatus {
        /** 回答本次请求的 cluster worker 标识（primary / 数字） */
        workerId: string;
        /** 总开关（AI_DETECT_ENABLED） */
        enabled: boolean;
        /** 本进程是否持有 leader 租约（全机只有一个进程会返回 true） */
        leader: boolean;
        /** 本队列的待处理任务数（来自本队列所在集合） */
        queueDepth: number;
        /** 本队列的并发上限（场景 AI_DETECT_CONCURRENCY / 抽帧 AI_DETECT_FRAME_CONCURRENCY，经规整后的实际值） */
        concurrency: number;
        /** 本进程在本队列上的在途任务数 */
        activeCount: number;
        /** 本队列最近一次进度 */
        lastProgress: { pct: number; stage: string } | null;
    }
}

/**
 * 大文件分片上传的通用类型声明（utils/chunkUpload/chunkSession.ts）。
 *
 * 会话不落库：元数据存 `uploads/<profile.subdir>/<uploadId>/meta.json`，分片存同目录的
 * `<下标>.part` —— 磁盘天然被 cluster 各 worker 共享，也天然支持续传（已存在的 .part 即
 * 「已收到」），无需为一次性的上传中间态建集合。体量上限/类型判定等业务口径由各域绑定的
 * Profile 提供：素材库（utils/constant/videoMaterial.ts）与场景切分（utils/constant/aiDetect.ts）。
 */
export namespace ChunkUpload {
    /** 分片上传会话初始化入参（POST .../chunks/init） */
    interface InitDto {
        /** 原始文件名，必填；扩展名决定 MIME，须在 profile 支持的类型内 */
        fileName: string;
        /** 文件总字节数（合并时按此校验，对不上即拒绝） */
        fileSize: number;
        /** 总分片数，必填；下标 0..totalChunks-1 */
        totalChunks: number;
        /** 单片字节数，可选；传了必须与 fileSize/totalChunks 自洽，否则 400 */
        chunkSize?: number;
    }

    /** 分片上传会话的对外视图（进度快照） */
    interface Session {
        /** 会话 id（crypto.randomUUID()，直接用作 uploads 下的目录名） */
        uploadId: string;
        /** 原始文件名（合并后作为 files 记录 originalName） */
        fileName: string;
        /** 声明的文件总字节数 */
        fileSize: number;
        /** 由扩展名推导的 MIME */
        mimeType: string;
        /** 总分片数 */
        totalChunks: number;
        /** 单片字节数（init 归一化后的实际值） */
        chunkSize: number;
        /** 已收到的分片下标（升序），客户端据此续传 */
        received: number[];
        /** 分片是否全部到齐（到齐即可调提交接口合并入库） */
        completed: boolean;
        /** 会话创建时间（ISO 字符串） */
        createdAt: string;
    }

    /** 会话元数据的落盘形态：received/completed 由目录实时扫描得出，不落盘 */
    type SessionMeta = Omit<ChunkUpload.Session, 'received' | 'completed'>;

    /** 上传单个分片的返回（POST .../chunks/:uploadId/:index） */
    interface ReceiveResult {
        /** 本次收到的分片下标 */
        index: number;
        /** 会话当前进度（含 received，客户端可据此判断还缺哪几片） */
        session: ChunkUpload.Session;
    }

    /** 业务域绑定的分片口径（utils/chunkUpload/chunkSession.ts 消费） */
    interface Profile {
        /** uploads 下的点号子目录（会话根）：各域互不干扰，也便于各自回收 */
        subdir: string;
        /** 业务名（错误提示用：「素材」/「视频」） */
        noun: string;
        /**
         * 合并后体量上限（字节）。分片的意义就是不受全局 FILE_MAX_SIZE 约束，
         * 但仍有独立上限 —— 上限只约束最终落盘的整份文件。
         */
        maxBytes: number;
        /** 单个分片大小上限（字节），同时是分片路由 multer 的传输上限 */
        maxChunkBytes: number;
        /** 分片数上限：每片至少落一个文件，防止 totalChunks 被填成天文数字耗光 inode */
        maxChunks: number;
        /** 文件名 → MIME；返回空串表示该扩展名不受支持（init 直接 400） */
        mimeFromName: (fileName: string) => string;
    }
}

/** 视频素材库接口类型声明（src/videoMaterial） */
export namespace VideoMaterial {
    /** 分片上传会话初始化入参（POST /api/videoMaterials/chunks/init） */
    type ChunkInitDto = ChunkUpload.InitDto;

    /** 分片上传会话的对外视图（进度快照），落盘形态见 ChunkUpload */
    type ChunkSession = ChunkUpload.Session;

    /** 会话元数据的落盘形态：received/completed 由目录实时扫描得出，不落盘 */
    type ChunkSessionMeta = ChunkUpload.SessionMeta;

    /** 上传单个分片的返回（POST /api/videoMaterials/chunks/:uploadId/:index） */
    type ChunkReceiveResult = ChunkUpload.ReceiveResult;
}

/** 图片理解（Qwen3-VL）接口类型声明（src/vlm） */
export namespace Vlm {
    /** 任务状态（cancelled 仅排队中可取消，running/终态不可取消） */
    type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

    /** 提交口径：multipart 上传 / 引用已有 file 记录 */
    type SourceType = 'upload' | 'fileId';

    /**
     * 输出形态：
     * - json 结构化字段（默认）——解析失败会重试一次，仍失败则任务判 failed
     * - text 自由文本——不要求 JSON，result 为空、rawText 即答案
     */
    type Mode = 'json' | 'text';

    /** 画面场景类型（取值集合与 utils/constant/vlm.ts 的 VLM_ALLOWED_SCENE_TYPES 一致） */
    type SceneType = 'indoor' | 'outdoor' | 'other';

    /**
     * 结构化理解结果（mode=json 且解析成功时的形态）。
     *
     * Node 侧 `normalizeVlmResult` 会做字段收敛：数组去空去重截断、sceneType 非法回落 other、
     * description 超长截断。因此这里声明为「收敛后」的形态。
     */
    interface Result {
        /** 一句话概括画面内容（中文） */
        description: string;
        /** 画面中的主要物体/人物名称 */
        objects: string[];
        /** 正在发生的动作 */
        actions: string[];
        /** 画面场景类型 */
        sceneType: SceneType;
        /** 便于检索的主题标签 */
        tags: string[];
    }

    /** 提交入参（mode/prompt 缺省值由 service 归一） */
    interface SubmitTaskDto {
        /** 输出形态，缺省 json */
        mode: Mode;
        /** 自定义指令，缺省用 VLM_DEFAULT_PROMPT */
        prompt: string;
        userId?: string;
    }

    /** 提交成功的返回 */
    interface TaskAccepted {
        taskId: string;
        /** 归一化后实际生效的输出形态（调用方传了非法值时也能知道自己拿到的是哪种） */
        mode: Mode;
        status: TaskStatus;
    }

    /** 理解任务（落库形态，对外统一用 id 而非 _id） */
    interface TaskRecord {
        id: string;
        status: TaskStatus;
        /** 提交口径（排障用） */
        sourceType: SourceType;
        /** 源图片 file 记录主键 */
        sourceFileId: string;
        /** 源图片下载地址，形如 /api/files/<id>/download */
        sourceUrl: string;
        /** 源图片原始文件名 */
        originalName: string;
        /** 实际下发的指令（缺省值已落库，便于复现） */
        prompt: string;
        /** 输出形态 */
        mode: Mode;
        /** 进度 0..1 */
        progress: number;
        /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
        stage: string;
        /** 该阶段的中文描述 */
        stageLabel: string;
        /** 人类可读描述 / 失败原因 */
        message: string;
        /** 结构化结果；mode=text 或未成功时为空 */
        result?: Result;
        /** 模型原始输出（排障用；JSON 解析失败时它是唯一线索） */
        rawText: string;
        /** 容器侧实际调用模型的次数（1=一次通过，2=首轮 JSON 不可解析后重试过） */
        modelCalls: number;
        /**
         * 容器侧实际使用的模型 id（排障用；运行时可换权重 base / 预量化版，记下来才知道这条结果是谁算的）。
         *
         * 刻意不叫 `model`：Mongoose Document 上已有 `model()` 方法，同名路径会被 Schema 类型拒绝。
         */
        modelId: string;
        /** 推理耗时（ms） */
        elapsedMs: number;
        startedAt?: Date;
        finishedAt?: Date;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    }

    /** 查询入参：status 可选，分页 page/limit */
    interface TaskQuery {
        status?: TaskStatus;
        page?: number;
        limit?: number;
    }

    /** 排队位置（口径同 claimNextPending 的 createdAt 升序 FIFO） */
    interface QueuePosition {
        taskId: string;
        status: TaskStatus;
        /** 队列中排在第几位；非 pending 时为 null */
        position: number | null;
        /** 前面还有多少条（含正在执行的那条） */
        waitingAhead: number;
        /** 待处理总数 */
        queueDepth: number;
        /** 正在执行数 */
        running: number;
    }

    /** 全局队列计数（不针对具体任务、不要求归属） */
    interface QueueStatus {
        total: number;
        pending: number;
        running: number;
    }

    /** 引擎状态（回答该请求的那个 cluster worker 的进程内视角） */
    interface EngineStatus {
        /** 执行进程标识 */
        workerId: string;
        /** 模块总开关（VLM_ENABLED） */
        enabled: boolean;
        /** 客户端配置是否可用（mode=remote 且配了 baseUrl） */
        configured: boolean;
        /**
         * 容器侧「模型在位」（`GET /readyz` 为 200）；
         * 未启用、未配置、模型尚未加载、或已被空闲卸载，均为 false。
         *
         * 注意它**不是**「服务是否可用」：容器默认懒加载 + 空闲卸载，未用过或已卸载时都是 false，
         * 而第一个任务会把它拉起来。调度器刻意不拿它当闸门（否则会「不加载就不领取」死锁）。
         */
        reachable: boolean;
        /** 本进程是否持有 leader 租约 */
        leader: boolean;
        /** 容器地址（排障用） */
        baseUrl: string;
        queueDepth: number;
        concurrency: number;
        activeCount: number;
        /** 最近一次上报的进度 */
        lastProgress: { pct: number; stage: string } | null;
    }

    /** 容器 GET /api/v1/jobs/{id}/result 的响应体（services/vlm/http/server.py 的 Job.payload） */
    interface JobResult {
        job_id: string;
        mode: Mode;
        /** 模型原始输出 */
        text: string;
        /** 解析出的对象；未解析成功时为 null */
        json: unknown;
        /** 是否拿到可解析的 JSON（mode=text 时恒为 false） */
        parse_ok: boolean;
        /** 实际调用模型的次数 */
        attempts: number;
        elapsed_ms: number | null;
        /** 产出该结果的模型 id（运行时可换权重） */
        model: string;
        /**
         * 本次生成是否顶到了容器侧 `VLM_MAX_NEW_TOKENS`。
         *
         * 成功时通常为 false —— 截断会让 JSON 不完整、或在 text 模式下截掉半句话，
         * 这两种情况容器都会判失败而不是返回。保留该字段是为了让契约完整、便于排障。
         */
        truncated: boolean;
        /**
         * 容器实际下发的指令（含容器侧兜底）。
         *
         * 存在的意义：Node 传空 prompt 时会静默走容器兜底，从外部完全看不出用的是哪句 ——
         * 排查时为此吃过亏，所以让它随结果一起返回。
         */
        resolved_prompt: string;
    }
}

/** 批量图像识别（基于场景抽帧关键帧）接口类型声明（src/vlmBatch） */
export namespace VlmBatch {
    /** 任务状态（cancelled 仅排队中可取消，与图片理解同口径） */
    type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

    /** 提交口径：目前只支持「已完成的场景抽帧任务」（aiDetectFrameTasks） */
    type SourceType = 'framesTask';

    /**
     * 单项状态：逐张关键帧各自的处理结果。
     *
     * 单项失败**不拖垮整批**：其余项照常识别，失败项在 items 里带自己的 message，
     * 批次总状态与计数（total/succeeded/failed）据此结算。
     */
    type ItemStatus = 'pending' | 'success' | 'failed';

    /** 单张关键帧的识别项（内嵌值对象，逐项可寻址：靠 index / fileId） */
    interface Item {
        /** 批次内的全局序号（从 0 起，与提交时按场景→帧位展开的顺序一致） */
        index: number;
        /** 所属场景序号（对应来源抽帧任务 frameScenes[].index） */
        sceneIndex: number;
        /** 帧位：开始 / 中间 / 结束 */
        frameKind: 'start' | 'mid' | 'end';
        /** 抽帧时间点（ms，落在该场景区间内） */
        timeMs: number;
        /** 帧图片在 file 表中的主键 */
        fileId: string;
        /** 帧图片下载地址，形如 /api/files/<id>/download */
        url: string;
        /** 本项处理状态 */
        status: ItemStatus;
        /** 结构化结果（mode=json 且本项成功时存在）；mode=text 或未成功时为空 */
        result?: Vlm.Result;
        /** 模型原始输出（排障用；本项 JSON 不合契约时它是唯一线索） */
        rawText: string;
        /** 本项失败原因；成功时为空串 */
        message: string;
        /** 容器侧实际调用模型的次数（本项） */
        modelCalls: number;
        /** 容器侧实际使用的模型 id（本项） */
        modelId: string;
        /** 本项推理耗时（ms） */
        elapsedMs: number;
    }

    /** 提交入参（唯一必需项是已完成抽帧任务的 id） */
    interface SubmitTaskDto {
        /** 输出形态，缺省 json（整批共用同一形态） */
        mode: Vlm.Mode;
        /** 自定义指令，缺省用 VLM_DEFAULT_PROMPT；整批共用同一句 */
        prompt: string;
        userId?: string;
    }

    /** 提交成功的返回 */
    interface TaskAccepted {
        taskId: string;
        /** 归一化后实际生效的输出形态 */
        mode: Vlm.Mode;
        status: TaskStatus;
        /** 本次批次纳入的关键帧总数（= items.length） */
        total: number;
    }

    /** 批量识别任务（落库形态，对外统一用 id 而非 _id） */
    interface TaskRecord {
        id: string;
        status: TaskStatus;
        /** 提交口径 */
        sourceType: SourceType;
        /** 来源抽帧任务 id */
        sourceTaskId: string;
        /** 源视频 file 记录主键（自来源抽帧任务继承，排障用） */
        sourceFileId: string;
        /** 源视频下载地址 */
        sourceUrl: string;
        /** 源视频原始文件名 */
        originalName: string;
        /** 整批实际下发的指令（缺省值已落库，便于复现） */
        prompt: string;
        /** 输出形态 */
        mode: Vlm.Mode;
        /** 进度 0..1（按已完成项数推进） */
        progress: number;
        /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
        stage: string;
        /** 该阶段的中文描述 */
        stageLabel: string;
        /** 人类可读描述 / 整批失败原因 */
        message: string;
        /** 纳入的关键帧总数（= items.length） */
        total: number;
        /** 识别成功项数 */
        succeeded: number;
        /** 识别失败项数 */
        failed: number;
        /** 逐项结果（提交时即展开为 pending，执行中逐项回写） */
        items: Item[];
        startedAt?: Date;
        finishedAt?: Date;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    }

    /** 查询入参：status 可选，分页 page/limit */
    interface TaskQuery {
        status?: TaskStatus;
        page?: number;
        limit?: number;
    }

    /** 排队位置（口径同 claimNextPending 的 createdAt 升序 FIFO） */
    interface QueuePosition {
        taskId: string;
        status: TaskStatus;
        /** 队列中排在第几位；非 pending 时为 null */
        position: number | null;
        /** 前面还有多少条（含正在执行的那条） */
        waitingAhead: number;
        /** 待处理总数 */
        queueDepth: number;
        /** 正在执行数 */
        running: number;
    }

    /** 全局队列计数（不针对具体任务、不要求归属） */
    interface QueueStatus {
        total: number;
        pending: number;
        running: number;
    }

    /** 引擎状态（回答该请求的那个 cluster worker 的进程内视角） */
    interface EngineStatus {
        /** 执行进程标识 */
        workerId: string;
        /** 模块总开关（VLM_BATCH_ENABLED） */
        enabled: boolean;
        /** 客户端配置是否可用（复用 vlmConfig：mode=remote 且配了 baseUrl） */
        configured: boolean;
        /** 容器侧「模型在位」；语义与 Vlm.EngineStatus.reachable 完全一致（非「服务是否可用」） */
        reachable: boolean;
        /** 本进程是否持有 leader 租约 */
        leader: boolean;
        /** 容器地址（排障用） */
        baseUrl: string;
        queueDepth: number;
        /** 本队列并发上限（VLM_BATCH_CONCURRENCY，与单图队列 VLM_CONCURRENCY 各算各的） */
        concurrency: number;
        activeCount: number;
        /** 最近一次上报的进度 */
        lastProgress: { pct: number; stage: string } | null;
    }
}

/**
 * 解说视频类型声明（src/narrationVideo）。
 *
 * 前端提交「解说结构化数据」+ 场景切分任务 id + 音色 id；后端从场景任务解析源视频，逐段拆成两段：
 * ① 解说段 —— 整段 [start,end] 画面（对源视频烧死字幕区域做模糊/遮罩）+ 对 text 做 TTS 配音 + 解说字幕；
 * ② 细节段 —— 取 clips 中时长最短的一段裁出的「原切视频」，保留原声原字幕、不叠解说字幕。
 * 两段拼接后烧录解说字幕成片。
 */
export namespace NarrationVideo {
  /** 任务状态（cancelled 仅排队中可取消，running/终态不可取消） */
  type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

  /** 前端提交的单个「细节段」出画片段（源视频时间轴，毫秒，左闭右开） */
  interface ClipInput {
    start: number;
    end: number;
    description?: string;
  }

  /** 前端提交的单个解说分段 */
  interface SegmentInput {
    /** 分段起点（ms，含） */
    start: number;
    /** 分段终点（ms，不含） */
    end: number;
    /** 解说文案（该段需要配音） */
    text: string;
    /** 情感标签，仅记录，暂不参与合成 */
    emotion?: string;
    /** 细节段「原切视频」候选片段（取时长最短的一段，并列取起点最早，保留原声原字幕）；为空则回退用整段 [start,end] */
    clips?: ClipInput[];
  }

  /** 解说结构化数据 */
  interface NarrationInput {
    title?: string;
    summary?: string;
    segments: SegmentInput[];
  }

  /** 落库后的单个出画片段（毫秒） */
  interface SegmentClip {
    /** 片段起点（ms，含） */
    startMs: number;
    /** 片段终点（ms，不含） */
    endMs: number;
    /** 片段描述（原样保留，便于回溯选段依据） */
    description: string;
  }

  /** 落库后的单个分段 */
  interface Segment {
    index: number;
    startMs: number;
    endMs: number;
    text: string;
    emotion: string;
    clips: SegmentClip[];
  }

  /** 单个分段的执行期状态（中断重排时据 voiceTaskId 复用配音子任务） */
  interface SegmentState {
    index: number;
    voiceTaskId: string;
    audioFileId: string;
    audioUrl: string;
    audioDurationMs: number;
  }

  /** 提交任务的入参（纯 JSON，无文件上传） */
  interface SubmitTaskDto {
    /** 来源场景切分任务 id（从中取源视频） */
    sceneTaskId: string;
    /** 音色库记录主键 */
    voiceId: string;
    /** 速度档位，缺省 balanced */
    speedMode?: string;
    /** 解说结构化数据 */
    narration: NarrationInput;
    /** 归属用户，缺省回退 JWT */
    userId?: string;
  }

  /** 提交任务的返回 */
  interface TaskAccepted {
    taskId: string;
    status: TaskStatus;
  }

  /** 分页查询任务的入参 */
  interface TaskQuery {
    status?: TaskStatus;
    page?: number;
    limit?: number;
  }

  /** 解说视频任务（落库形态，对外统一用 id 而非 _id） */
  interface TaskRecord {
    id: string;
    status: TaskStatus;
    /** 来源场景切分任务 id */
    sceneTaskId: string;
    /** 源视频 file 记录主键 */
    sourceFileId: string;
    /** 源视频下载地址 */
    sourceUrl: string;
    /** 源视频原始文件名 */
    sourceOriginalName: string;
    /** 源视频总时长（ms） */
    sourceDurationMs: number;
    /** 解说标题 */
    title: string;
    /** 解说概要 */
    summary: string;
    /** 解说分段 */
    segments: Segment[];
    /** 音色库记录主键 */
    voiceId: string;
    /** 速度档位：fast / balanced / quality */
    speedMode: string;
    /** 进度 0..1 */
    progress: number;
    /** ASCII 阶段 key，前端用 stageLabel 映射中文 */
    stage: string;
    /** 该阶段的中文描述 */
    stageLabel: string;
    /** 人类可读描述 / 失败原因 */
    message: string;
    /** 各分段执行期状态（配音子任务 id 与音频产物） */
    segmentStates: SegmentState[];
    /** 解说字幕 SRT 的 file 主键，仅 success 时非空 */
    srtFileId: string;
    /** 解说字幕下载地址，仅 success 时非空 */
    srtUrl: string;
    /** 字幕条数 */
    cueCount: number;
    /** 成片视频 file 主键，仅 success 时非空 */
    videoFileId: string;
    /** 成片视频下载地址，仅 success 时非空 */
    videoUrl: string;
    /** 成片时长（秒） */
    videoDuration: number;
    startedAt?: Date;
    finishedAt?: Date;
    userId: string;
    createdAt: Date;
    updatedAt: Date;
  }

  /** 任务排队位置（全局 FIFO 口径，与 dispatcher 的领取顺序一致） */
  interface TaskQueuePosition {
    taskId: string;
    status: TaskStatus;
    /** 待处理队列中的位次，1 = 下一个被领取；非 pending 时为 null */
    position: number | null;
    /** 前方还需跑完的任务数（含正在执行的那条）；非 pending 时为 0 */
    waitingAhead: number;
    /** 全局待处理任务数 */
    queueDepth: number;
    /** 当前正在执行的任务数（上限为 NARRATION_VIDEO_CONCURRENCY） */
    running: number;
  }

  /** 全局队列计数（不针对具体任务、不要求归属） */
  interface QueueStatus {
    total: number;
    pending: number;
    running: number;
  }

  /** 引擎状态（进程内视角，回答该请求的那个 cluster worker） */
  interface EngineStatus {
    workerId: string;
    /** 模块总开关（NARRATION_VIDEO_ENABLED） */
    enabled: boolean;
    /** 本进程是否持有 leader 租约 */
    leader: boolean;
    /** 配音通道（IndexTTS） */
    voice: { enabled: boolean; mode: 'remote' | 'local' | 'off' };
    /** 待处理任务数（全局，来自 Mongo） */
    queueDepth: number;
    /** 调度器并发上限（NARRATION_VIDEO_CONCURRENCY，经规整后实际值） */
    concurrency: number;
    /** 本进程当前在途任务数 */
    activeCount: number;
  }
}
