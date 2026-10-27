import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 任务状态：pending 待领取 / running 执行中 / success 成功 / failed 失败 / cancelled 已取消 */
export type NarrationVideoTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/** 单个「细节段」出画片段（源视频时间轴，毫秒，左闭右开） */
export interface INarrationClip {
  startMs: number;
  endMs: number;
  description: string;
}

/** 单个解说分段：一段解说文案 + 其细节段原切片段 */
export interface INarrationSegment {
  /** 序号，从 1 开始 */
  index: number;
  startMs: number;
  endMs: number;
  /** 解说文案（该段需要配音） */
  text: string;
  /** 情感标签，仅记录，暂不参与合成 */
  emotion: string;
  /** 细节段「原切视频」候选片段（取时长最短的一段，并列取起点最早，保留原声原字幕）；为空表示用整段 [startMs,endMs] */
  clips: INarrationClip[];
}

/** 单段的执行期状态：中断重排时据 voiceTaskId 复用配音子任务 */
export interface INarrationSegmentState {
  index: number;
  /** 复用的 IndexTTS 配音子任务 id */
  voiceTaskId: string;
  /** 配音产物 file 记录 id */
  audioFileId: string;
  /** 配音产物下载地址 */
  audioUrl: string;
  /** 配音音频时长（ms） */
  audioDurationMs: number;
}

/**
 * 解说视频任务。
 *
 * 输入是前端提交的「解说结构化数据」+ 场景切分任务 id + 音色 id；执行流为：
 * 从场景任务解析源视频 → 逐段「解说段（整段 [start,end] 画面去源字幕 + TTS 配音 + 解说字幕）+
 * 细节段（取 clips 中时长最短的一段裁出的原切视频，保留原声原字幕）」→ 拼接 → 烧录解说字幕。
 *
 * 提交接口只建 pending 记录并立即返回 taskId，真正执行的是全机唯一的 leader dispatcher
 * （见 narrationVideoDispatcher.ts）。本模块不持有 GPU 模型：配音复用 voiceTrainV2 合成任务。
 */
export interface INarrationVideoTask extends IBaseMongoEntity {
  status: NarrationVideoTaskStatus;

  /** 来源场景切分任务 id（提交时校验为 success） */
  sceneTaskId: string;
  /** 源视频 file 记录 id（自场景任务继承） */
  sourceFileId: string;
  /** 源视频下载地址（自场景任务继承，形如 /api/files/<id>/download） */
  sourceUrl: string;
  /** 源视频原始文件名（自场景任务继承，同时是成片文件名词干兜底） */
  sourceOriginalName: string;
  /** 源视频总时长（ms；场景任务给 0 时执行期用 ffprobe 补齐） */
  sourceDurationMs: number;

  /** 解说标题 */
  title: string;
  /** 解说概要 */
  summary: string;
  /** 解说分段（归一化快照：毫秒、clips 已 clamp 到源视频时长并按 startMs 排序） */
  segments: INarrationSegment[];

  /** 音色库记录 id（voiceTrainV2Voices） */
  voiceId: string;
  /** 速度档位：fast / balanced / quality */
  speedMode: string;

  /** 执行期状态 */
  /** 进度 0..1 */
  progress: number;
  /** ASCII 阶段 key（见 utils/constant/narrationVideo.ts 的映射） */
  stage: string;
  /** 人类可读描述；失败原因也写这里 */
  message: string;
  /** 执行进程标识（排障用：哪个 cluster worker 跑的） */
  workerId: string;
  /** 被领取次数；>1 说明经历过中断重领 */
  attempts: number;

  /** 各分段的执行期状态（逐段配音产物） */
  segmentStates: INarrationSegmentState[];

  /** 解说字幕 SRT 的 file 记录 id */
  srtFileId: string;
  /** 解说字幕下载地址 */
  srtUrl: string;
  /** 字幕条数 */
  cueCount: number;

  /** 成品视频 file 记录 id */
  videoFileId: string;
  /** 成品视频下载地址 */
  videoUrl: string;
  /** 成品视频时长（秒） */
  videoDuration: number;

  startedAt?: Date;
  finishedAt?: Date;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 解说视频任务 Mongoose Document 类型 */
export type NarrationVideoTaskDocument = BaseDocument & INarrationVideoTask;

const NarrationClipSchema = new mongoose.Schema<INarrationClip>(
  {
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    description: { type: String, default: '' },
  },
  // 片段是分段的内嵌值对象，没有独立身份
  { _id: false },
);

const NarrationSegmentSchema = new mongoose.Schema<INarrationSegment>(
  {
    index: { type: Number, required: true },
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    text: { type: String, required: true },
    emotion: { type: String, default: '' },
    clips: { type: [NarrationClipSchema], default: [] },
  },
  { _id: false },
);

const NarrationSegmentStateSchema = new mongoose.Schema<INarrationSegmentState>(
  {
    index: { type: Number, required: true },
    voiceTaskId: { type: String, default: '' },
    audioFileId: { type: String, default: '' },
    audioUrl: { type: String, default: '' },
    audioDurationMs: { type: Number, default: 0 },
  },
  { _id: false },
);

const NarrationVideoTaskSchema = new mongoose.Schema<NarrationVideoTaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },

    sceneTaskId: { type: String, default: '', index: true },
    sourceFileId: { type: String, default: '' },
    sourceUrl: { type: String, default: '' },
    sourceOriginalName: { type: String, default: '' },
    sourceDurationMs: { type: Number, default: 0 },

    title: { type: String, default: '' },
    summary: { type: String, default: '' },
    segments: { type: [NarrationSegmentSchema], default: [] },

    voiceId: { type: String, default: '', index: true },
    speedMode: { type: String, default: 'balanced' },

    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },

    segmentStates: { type: [NarrationSegmentStateSchema], default: [] },

    srtFileId: { type: String, default: '' },
    srtUrl: { type: String, default: '' },
    cueCount: { type: Number, default: 0 },

    videoFileId: { type: String, default: '' },
    videoUrl: { type: String, default: '' },
    videoDuration: { type: Number, default: 0 },

    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'narrationVideoTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
NarrationVideoTaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
NarrationVideoTaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
NarrationVideoTaskSchema.index({ userId: 1, createdAt: -1 });

const NarrationVideoTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<NarrationVideoTaskDocument>('NarrationVideoTask', NarrationVideoTaskSchema);

export default NarrationVideoTaskModel;
