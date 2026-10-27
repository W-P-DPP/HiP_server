import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 视频生成管道 V2 任务状态：pending 待领取 / running 执行中 / success 成功 / failed 失败 / cancelled 已取消 */
export type VideoPipelineV2TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/**
 * 任务模式：
 * - pipeline 完整管道（IndexTTS 配音 → Whisper 字幕 → 背景轨 → 合成）
 * - compose  纯合成（直接用已知音频/字幕产物 → 背景轨 → 合成）
 */
export type VideoPipelineV2TaskMode = 'pipeline' | 'compose';

/**
 * 视频生成管道 V2 任务。
 *
 * 与 V1（src/voiceTrain/voicePipelineTask.entity.ts）的区别只在两段外部调用：
 * 配音走本地 IndexTTS（复用 voiceTrainV2 合成任务）、字幕走本地 Whisper（复用 subtitle 任务），
 * 其后的背景轨与 toVideo 烧录完全复用 utils/videoHelper。
 *
 * 提交接口只建 pending 记录并立即返回 taskId，真正执行的是全机唯一的 leader dispatcher。
 * 音频/字幕不重复落 file 表 —— 直接引用两个子任务各自的产物 fileId/url。
 */
export interface IVideoPipelineV2Task extends IBaseMongoEntity {
  status: VideoPipelineV2TaskStatus;
  /** 任务模式：pipeline 完整管道 / compose 纯合成 */
  mode: VideoPipelineV2TaskMode;

  /** 待合成文本（入参快照；compose 模式仅记录，可为空） */
  text: string;
  /** 音色库记录 id（voiceTrainV2Voices），零样本克隆的参考音来源（compose 模式仅记录，可为空） */
  voiceId: string;
  /** 速度档位：fast / balanced / quality */
  speedMode: string;
  /** 背景色（色名或 #RRGGBB，缺省 black） */
  color?: string;
  /** 每个字幕段落对应的 Pixabay 素材搜索词（缺省用 cue 文本清洗截断） */
  keywords?: string[];

  /** 执行期状态 */
  /** 进度 0..1 */
  progress: number;
  /** ASCII 阶段 key（见 utils/constant/videoPipelineV2.ts 的映射） */
  stage: string;
  /** 人类可读描述；失败原因也写这里 */
  message: string;
  /** 执行进程标识（排障用：哪个 cluster worker 跑的） */
  workerId: string;
  /** 被领取次数；>1 说明经历过中断重领 */
  attempts: number;

  /** 配音子任务（voiceTrainV2SynthesisTasks）id，中断重排时据此复用 */
  voiceTaskId: string;
  /** 配音产物 file 记录 id */
  audioFileId: string;
  /** 配音产物下载地址 */
  audioUrl: string;
  /** 配音音频时长（秒） */
  audioDuration: number;

  /** 字幕子任务（subtitleTasks）id，中断重排时据此复用 */
  subtitleTaskId: string;
  /** 字幕 SRT 的 file 记录 id */
  srtFileId: string;
  /** 字幕下载地址 */
  srtUrl: string;
  /** 字幕条数 */
  cueCount: number;
  /** 实际生效的 ASR 通道：xunfei / whisper，成功前为空 */
  provider: string;

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

/** 视频生成管道 V2 任务 Mongoose Document 类型 */
export type VideoPipelineV2TaskDocument = BaseDocument & IVideoPipelineV2Task;

const VideoPipelineV2TaskSchema = new mongoose.Schema<VideoPipelineV2TaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    mode: {
      type: String,
      enum: ['pipeline', 'compose'],
      default: 'pipeline',
      index: true,
    },
    // compose 模式不产生文案/音色，故不做 required（完整管道路径的非空校验由 service 承担）
    text: { type: String, default: '' },
    voiceId: { type: String, default: '', index: true },
    speedMode: { type: String, default: 'balanced' },
    color: { type: String },
    keywords: { type: [String], default: [] },
    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    voiceTaskId: { type: String, default: '' },
    audioFileId: { type: String, default: '' },
    audioUrl: { type: String, default: '' },
    audioDuration: { type: Number, default: 0 },
    subtitleTaskId: { type: String, default: '' },
    srtFileId: { type: String, default: '' },
    srtUrl: { type: String, default: '' },
    cueCount: { type: Number, default: 0 },
    provider: { type: String, default: '' },
    videoFileId: { type: String, default: '' },
    videoUrl: { type: String, default: '' },
    videoDuration: { type: Number, default: 0 },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'videoPipelineV2Tasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
VideoPipelineV2TaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
VideoPipelineV2TaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
VideoPipelineV2TaskSchema.index({ userId: 1, createdAt: -1 });

const VideoPipelineV2TaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<VideoPipelineV2TaskDocument>('VideoPipelineV2Task', VideoPipelineV2TaskSchema);

export default VideoPipelineV2TaskModel;
