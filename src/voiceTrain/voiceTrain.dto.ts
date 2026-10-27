/** 创建训练任务请求体（可选字段覆盖默认值） */
export interface CreateVoiceTrainTaskDto {
    taskName?: string;
    sex?: number;
    ageGroup?: number;
    resourceType?: number;
    thirdUser?: string;
    language?: string;
    denoise?: number;
    mosRatio?: number | string;
    resourceName?: string;
    callbackUrl?: string;
}

/** 上传音频+提交训练请求体（音频文件由 multer 提供，不在 DTO 中） */
export interface SubmitAudioDto {
    /** 训练任务唯一 id */
    taskId: string;
    /** 文本ID（缺省回退 XUNFEI_TEXTID=5001） */
    textId?: string;
    /** 训练文本段落 ID，如 1, 2, 3 */
    textSegId: string;
    /** 音频评分阈值，范围 0.0-5.0，0 表示关闭 */
    mosRatio?: number | string;
}

/** 上传音频并自动创建训练任务请求体（音频文件由 multer 提供，不在 DTO 中） */
export interface SubmitTrainWithAudioDto {
    /** 归属用户 id */
    userId: string;
    /** 训练文本段落 ID，如 1, 2, 3 */
    textSegId: string;
    /** 音色资源名称（必填：用户提交的最终展示/匹配名，回调/轮询不覆盖，改名走 PUT /result） */
    resourceName: string;
    /** 文本ID（缺省回退 XUNFEI_TEXTID=5001） */
    textId: string;
    /** 音频评分阈值，范围 0.0-5.0，0 表示关闭 */
    mosRatio?: number | string;
    sex: number;
}

/** 查询训练结果请求体 */
export interface GetTrainResultDto {
    /** 训练任务 id */
    taskId: string;
    /** 归属用户 id（由用户上传，未传时回退 JWT） */
    userId?: string;
}

/** 音频合成请求体（音色克隆 voice_clone） */
export interface SynthesizeAudioDto {
    /** 训练得到的音色 id（训练结果中的音色资源 id） */
    resId: string;
    /** 待合成文本 */
    text: string;
    /** 语速，0-100 */
    speed?: number;
    /** 音量，0-100 */
    volume?: number;
    /** 语调，0-100 */
    pitch?: number;
    /** 合成语种：0 中 / 1 英 / 2 日 / 3 韩 / 4 俄，默认 0 */
    language?: number;
    /** 音频编码：lame(mp3) / raw(pcm)，默认 lame */
    encoding?: string;
    /** 采样率，默认 24000 */
    sampleRate?: number;
}

/** 音频合成结果（落盘后的文件信息，后台任务内部使用） */
export interface SynthesizeResult {
    /** 文件记录 id */
    fileId: string;
    /** 原始文件名 */
    originalName: string;
    /** MIME 类型 */
    mimeType: string;
    /** 文件大小（字节） */
    size: number;
    /** 下载地址 */
    url: string;
}

/** 音频合成任务提交结果（异步） */
export interface SynthesisSubmitResult {
    /** 合成任务 id */
    taskId: string;
    /** 任务状态，提交时为 pending */
    status: 'pending';
}

/** 音频合成任务状态查询结果 */
export interface SynthesisTaskResult {
    /** 合成任务 id */
    taskId: string;
    /** 任务状态：pending / running / success / failed */
    status: string;
    /** 合成成功后的下载地址 */
    resultUrl?: string;
    /** 合成成功后的文件记录 id */
    resultFileId?: string;
    /** 失败原因 */
    message?: string;
}

/** 视频生成管道请求体（与音频合成同参，另加背景色） */
export interface CreatePipelineTaskDto {
    /** 训练得到的音色 id */
    resId: string;
    /** 待合成文本 */
    text: string;
    /** 语速，0-100 */
    speed?: number;
    /** 音量，0-100 */
    volume?: number;
    /** 语调，0-100 */
    pitch?: number;
    /** 合成语种：0 中 / 1 英 / 2 日 / 3 韩 / 4 俄，默认 0 */
    language?: number;
    /** 音频编码：默认 lame(mp3)（合成音频） */
    encoding?: string;
    /** 采样率，默认 24000 */
    sampleRate?: number;
    /** 视频背景色（色名或 #RRGGBB），默认 black */
    color?: string;
    /** 可选：每个字幕段落对应的 Pixabay 素材搜索词；缺省用 cue 文本清洗截断（中文命中率低，建议传英文词） */
    keywords?: string[];
    /** 提交人（由控制器从 body.userId 或 JWT 解析，缺省不绑定） */
    userId?: string;
}

/** 视频生成管道任务提交结果（异步） */
export interface PipelineTaskSubmitResult {
    /** 管道任务 id */
    taskId: string;
    /** 任务状态，提交时为 pending */
    status: 'pending';
}

/** 录音文件转写（raasr）请求体（音频文件由 multer 提供，不在 DTO 中） */
export interface RaasrTranscribeDto {
    /** 音频真实时长（毫秒，可选；不传则省略该参数，避免 failType5 音频校验失败） */
    duration?: number;
    /** 语种（可选，不传默认 autodialect） */
    language?: string;
    /** 是否开启角色分离 */
    roleType?: number;
    /** 转写完成回调地址 */
    callbackUrl?: string;
}

/** 录音文件转写结果（同步接口直接返回） */
export interface RaasrTranscribeResult {
    /** 讯飞转写订单 id */
    orderId: string;
    /** 订单状态：4 完成 / 1 完成 / -1 失败 / 2 失败 */
    status: number;
    /** 转写文本（成功时返回） */
    text?: string;
    /** 音频原始时长（毫秒） */
    originalDuration?: number;
    /** 音频实际转写时长（毫秒） */
    realDuration?: number;
}

/** 查询训练结果列表请求参数（分页） */
export interface VoiceTrainResultQueryDto {
    /** 页码，从 1 开始 */
    page?: number;
    /** 每页条数，默认 20，上限 100 */
    limit?: number;
}

/** 修改训练结果请求体（仅允许修改 resourceName 展示/匹配名） */
export interface UpdateVoiceTrainResultDto {
    /** 讯飞训练任务 id（唯一键，定位记录） */
    taskId: string;
    /** 新的音色资源名称（必填、trim 后非空） */
    resourceName: string;
}

/** 训练结果列表项（剔除 _id、userId 及基础字段，仅暴露业务字段与时间戳） */
export interface VoiceTrainResultItemDto {
    /** 讯飞训练任务 id */
    taskId: string;
    /** 任务名称 */
    taskName: string;
    /** 音色资源名称 */
    resourceName: string;
    /** 训练视频 id */
    trainVid: string;
    /** 训练得到的音色标识（回调推送 trainVcn，可复用为下游合成 resId） */
    trainVcn: string;
    /** 训练得到的音色资源 id（可复用为下游 resId） */
    assetId: string;
    /** 训练 id */
    trainId: string;
    /** 应用 id */
    appId: string;
    /** 失败描述 */
    failedDesc: string;
    /** 性别 */
    sex: number;
    /** 训练状态 */
    trainStatus: number;
    /** 年龄段 */
    ageGroup: number;
    /** 训练文本段落 ID */
    textSegId?: string;
    /** 文本 ID */
    textId?: string;
    /** 落库时间（ISO 字符串） */
    createdAt?: string;
    /** 最后更新时间（ISO 字符串） */
    updatedAt?: string;
}

/** 视频生成管道任务状态查询结果 */
export interface PipelineTaskResult {
    /** 管道任务 id */
    taskId: string;
    /** 任务状态：pending / running / success / failed */
    status: string;
    /** 合成音频下载地址 */
    audioUrl?: string;
    /** 合成音频文件记录 id */
    audioFileId?: string;
    /** SRT 字幕下载地址 */
    subtitleSrtUrl?: string;
    /** SRT 字幕文件记录 id */
    subtitleSrtFileId?: string;
    /** ASS 字幕下载地址 */
    subtitleAssUrl?: string;
    /** ASS 字幕文件记录 id */
    subtitleAssFileId?: string;
    /** 成品视频下载地址 */
    videoUrl?: string;
    /** 成品视频文件记录 id */
    videoFileId?: string;
    /** 失败原因 */
    message?: string;
}

/** 视频生成任务分页查询入参 */
export interface PipelineTaskQueryDto {
    /** 页码，从 1 开始 */
    page?: number;
    /** 每页条数，默认 20，上限 100 */
    limit?: number;
    /** 任务 id 关键字（对 _id 字符串做不区分大小写的模糊匹配） */
    taskId?: string;
}

/** 视频合成任务队列实时状态（全局，跨 worker 一致） */
export interface PipelineQueueStatusDto {
    /** 待执行任务数（Mongo 中 status=pending 的未删除记录数，全局跨 worker） */
    pending: number;
    /** 执行中任务数（Mongo 中 status=running 的未删除记录数，全局跨 worker） */
    running: number;
    /** 任务总数（= pending + running，Mongo 全局口径） */
    total: number;
    /** 并发上限（VIDEO_TASK_CONCURRENCY，经规整后实际值） */
    concurrency: number;
    /** 全局已占用槽位数（Redis 信号量实时占用；与 running 可短暂不一致，任务先持槽后 claimRunning） */
    globalRunning: number;
    /** 响应本请求的 worker 标识（cluster worker id，单进程/主进程为 primary） */
    workerId: string;
}

/** 视频生成任务列表项（分页列表用，剔除内部字段，长文截断） */
export interface PipelineTaskItemDto {
    taskId: string;
    status: string;
    /** 待合成文本（截断展示） */
    text?: string;
    /** 合成语种 */
    language?: number;
    /** 成品视频下载地址 */
    videoUrl?: string;
    /** 成品视频文件记录 id */
    videoFileId?: string;
    /** SRT 字幕下载地址 */
    subtitleSrtUrl?: string;
    /** 失败原因 / 状态描述 */
    message?: string;
    /** 提交时间 */
    createdAt?: string;
    /** 完成时间 */
    finishedAt?: string;
}
