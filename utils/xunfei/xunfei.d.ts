/** 获取 token 的响应结构（字段路径待按实际接口确认） */
export interface XunfeiTokenResponse {
        retcode?: string,
        accesstoken?: string,
        expiresin?: string,
}

/** 获取云端训练文本的响应结构（音色训练接口，POST /voice_train/task/traintext） */
export interface XunfeiTrainTextResponse {
        /** 返回码，0 表示成功 */
        code: number,
        /** 返回描述 */
        desc: string,
        /** 返回数据 */
        data: XunfeiTrainTextData,
        /** true or false */
        flag: boolean,
}
/** 创建训练任务 */
export interface XunfeiTrainCreateResponse {
        /** 返回码，0 表示成功 */
        code: number,
        /** 返回描述 */
        desc: string,
        /** 任务id */
        data: string,
        /** true or false */
        flag: boolean,
}
/** 训练结果 */
export interface XunfeiTrainResultDto {
        taskName: string,
        resourceName: string,
        trainVid: string,
        assetId: string,
        trainId: string,
        appId: string,
        failedDesc: string,
        sex: number,
        trainStatus: number,
        ageGroup: number,
}
export interface XunfeiTrainResultResponse {
        /** 返回码，0 表示成功 */
        code: number,
        /** 返回描述 */
        desc: string,
        /** 任务id */
        data: XunfeiTrainResultDto |null,
        /** true or false */
        flag: boolean,
}

/** 训练文本数据 */
export interface XunfeiTrainTextData {
        /** 文本ID */
        textId: number,
        /** 文本名称 */
        textName: string,
        /** 文本列表 */
        textSegs: XunfeiTextSeg[],
}

/** 训练文本段落（segId 文档标注 string，实测返回 number，故用联合类型） */
export interface XunfeiTextSeg {
        /** 段落ID，表示第几段文本 */
        segId: number | string,
        /** 文本内容 */
        segText: string,
        /** 文本类型（实测返回空字符串） */
        segTextType: string,
        /** 文本语言，如 zh_cn / en_us */
        segTextLan: string,
        /** 段落排序 */
        segSort: number,
}

/** 创建训练任务入参（可选字段覆盖默认值） */
export interface TrainCreateParams {
        taskName?: string,
        sex?: number,
        ageGroup?: number,
        resourceType?: number,
        thirdUser?: string,
        language?: string,
        denoise?: number,
        mosRatio?: number | string,
        resourceName?: string,
        callbackUrl?: string,
}

/** 音色克隆 · 音频合成入参（voice_clone WebSocket） */
export interface VoiceCloneParams {
    /** 待合成文本 */
    text: string;
    /** 训练得到的音色 id（训练结果中的音色资源 id） */
    resId: string;
    /** 发言人名称，默认 x5_clone */
    vcn?: string;
    /** 合成语种：0 中 / 1 英 / 2 日 / 3 韩 / 4 俄，默认 0 */
    LanguageID?: number;
    /** 语速，0-100，100 = 默认语速 2 倍 */
    speed?: number;
    /** 音量，0-100，100 = 默认音量 2 倍 */
    volume?: number;
    /** 语调，0-100，100 = 默认语调 2 倍 */
    pitch?: number;
    /** 背景音：0 无，1/2 内置背景音 */
    bgs?: number;
    /** 音频编码：lame(mp3) / raw(pcm) / speex / opus，推荐 lame */
    encoding?: string;
    /** 采样率，默认 24000 */
    sampleRate?: number;
    /** 合成超时（毫秒），默认 60000 */
    timeout?: number;
    /** 单帧文本上限（base64 字节数），默认 7800（接口限制 8000，留安全裕量） */
    maxTextBytes?: number;
}

/** 音色克隆 · 音频合成结果 */
export interface VoiceCloneResult {
    /** 合成音频（mp3/pcm 完整数据） */
    audio: Buffer;
    /** 音频编码（同入参 encoding） */
    encoding: string;
    /** 采样率（同入参 sampleRate） */
    sampleRate: number;
}

/** 音色克隆 WebSocket 文本状态帧（实测：成功帧 {"header":{"code":0,"status":2},"payload":{"audio":{"audio":"<base64>","status":2,...}}}） */
export interface XunfeiCloneResponse {
    /** 状态头（code/message/sid/status 均在 header 内） */
    header?: {
        /** 返回码，0 表示成功 */
        code?: number;
        /** 返回描述 */
        message?: string;
        /** 会话 id */
        sid?: string;
        /** 状态，2 表示合成结束 */
        status?: number;
    };
    /** 兼容兜底：部分响应 code/message 在顶层 */
    code?: number;
    message?: string;
    sid?: string;
    /** 状态数据，data.status === 2 表示合成结束 */
    data?: { status?: number };
    /** 兜底：状态也可能在顶层 */
    status?: number;
    /** 音频载荷：音频以 base64 方式放在 payload.audio.audio */
    payload?: {
        audio?: {
            /** base64 编码的音频块 */
            audio?: string;
            /** 音频流状态，2 表示最后一块 */
            status?: number;
            /** 编码：lame / raw 等 */
            encoding?: string;
            /** 采样率 */
            sample_rate?: number;
            /** 位深 */
            bit_depth?: number;
            /** 声道数 */
            channels?: number;
            /** 音频块序号 */
            seq?: number;
            /** 帧大小 */
            frame_size?: number;
            /** 类型 */
            type?: string;
            /** 块 id */
            id?: string;
        };
    };
}

/** 录音文件转写（大模型版 Ifasr_llm）上传入参 */
export interface RaasrUploadParams {

    /** 音频文件大小 */
    fileSize: string,
    /** 音频文件名（需带真实后缀，影响服务端转码），如 meeting.wav */
    fileName: string,
    /** 音频 MIME 类型 */
    mimeType?: string,
    /** 音频真实时长（毫秒，官方标注未严格校验，可传占位） */
    duration?: number,
    /** 语种，默认 cn（中文），支持 en/ja/ko/ru/fr/es 等 */
    language?: string,
    /** 转写完成回调地址（服务端 GET 请求，参数 orderId/status） */
    callbackUrl?: string,
    /** 是否开启角色分离 */
    roleType?: number,
    /** 角色分离的角色数量 */
    roleNum?: number,
    /** 发音词典 / 语言模型参数 */
    pd?: string,
    /** 热词等 feature 配置 */
    featureIds?: string,
    /** 英文顺滑处理（只对英语生效） */
    eng_smoothproc?: boolean,
    /** 英文口语化处理（只对英语生效） */
    eng_colloqproc?: boolean,
    /** 英文断句灵敏度，取值范围 [20, 80]，默认 50 */
    eng_vad_mdn?: number,
    /** 签名随机串（一般由内部生成，getResult 时需复用；传入则跳过内部生成） */
    signatureRandom?: string,
    /** 上传时间（默认当前时间，自动格式化为 dateTime） */
    dateTime?: Date | string,
    /** 【已废弃，大模型版不再支持】热词，如 "热词1|热词2" */
    hotWord?: string,
    /** 【已废弃，大模型版不再支持】双声道分轨模式 */
    trackMode?: number,
}

/** 录音文件转写上传响应（大模型版 Ifasr_llm /v2/upload） */
export interface RaasrUploadResponse {
    /** 返回码，"000000"/"0" 或 descInfo=success 表示成功 */
    code: string,
    /** 返回描述 */
    descInfo: string,
    content?: {
        /** 转写订单 id，getResult 必传 */
        orderId: string,
        /** 订单预估耗时（毫秒） */
        taskEstimateTime?: number,
    },
    /** 签名随机串（服务器回显，实际以本地生成值为准） */
    signatureRandom?: string,
    /** 请求时间（服务器回显） */
    dateTime?: string,
}

/** 录音文件转写 getResult 响应（大模型版 Ifasr_llm /v2/getResult） */
export interface RaasrGetResultResponse {
    /** 返回码，"000000"/"0" 或 descInfo=success 表示成功；26605 表示任务处理中 */
    code: string,
    /** 返回描述 */
    descInfo: string,
    content?: {
        orderInfo?: {
            /** 转写订单 id */
            orderId: string,
            /** 订单状态：4 完成 / 3 处理中 / 0 已创建（视为处理中） */
            status: number,
            /** 失败类型（status 非 0/3/4 时可见） */
            failType?: string | number,
            /** 原始音频时长（毫秒） */
            originalDuration?: number,
            /** 转写后的真实音频时长（毫秒） */
            realDuration?: number,
            /** 结果过期时间（毫秒时间戳） */
            expireTime?: number,
            /** 识别语种 */
            language?: string,
        },
        /** 转写结果（JSON 字符串，lattice/lattice2 结构，status=4 时非空） */
        orderResult?: string,
    },
}

/** 录音文件转写结果（getResult 归一化后） */
export interface RaasrResult {
    /** 订单状态：4 完成 / 3 处理中 / -1 失败 */
    status: number,
    /** 转写文本（status=4 时非空） */
    text: string,
    /** 原始音频时长（毫秒） */
    originalDuration?: number,
    /** 转写后的真实音频时长（毫秒） */
    realDuration?: number,
    /** 失败类型（status=-1 时可见） */
    failType?: string,
    /** 原始 orderResult 字符串，便于上层自定义解析 */
    rawResult?: string,
}

/** 提交音频训练入参（替代 File 对象） */
export interface SubmitWithAudioParams {
        /** 音频文件二进制内容 */
        fileBuffer: Buffer,
        /** 上传文件名（带扩展名） */
        fileName: string,
        /** 音频 MIME 类型 */
        mimeType: string,
        /** 训练任务唯一 id */
        taskId: string,
        /** 文本ID（通用训练文本 textId=5001） */
        textId: string,
        /** 训练文本段落 ID，如 1, 2, 3 */
        textSegId: string,
        /** 音频评分阈值，范围 0.0-5.0，0 表示关闭 */
        mosRatio?: number | string,
}