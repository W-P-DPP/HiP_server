import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 视频生成管道任务状态 */
export type VoicePipelineTaskStatus = 'pending' | 'running' | 'success' | 'failed';

/** 视频生成管道任务实体字段（不含 Mongoose Document 方法） */
export interface IVoicePipelineTask extends IBaseMongoEntity {
  status: VoicePipelineTaskStatus;
  /** 待合成文本（入参快照） */
  text: string;
  /** 训练得到的音色 id */
  resId: string;
  /** 语速 */
  speed?: number;
  /** 音量 */
  volume?: number;
  /** 语调 */
  pitch?: number;
  /** 合成语种 */
  language?: number;
  /** 音频编码（合成音频，默认 lame/mp3） */
  encoding?: string;
  /** 采样率 */
  sampleRate?: number;
  /** 背景色（色名或 #RRGGBB，缺省 black） */
  color?: string;
  /** 每个字幕段落对应的 Pixabay 素材搜索词（缺省用 cue 文本清洗截断） */
  keywords?: string[];
  /** 合成音频文件记录 id */
  audioFileId?: string;
  /** 合成音频下载地址 */
  audioUrl?: string;
  /** SRT 字幕文件记录 id */
  srtFileId?: string;
  /** SRT 字幕下载地址 */
  srtUrl?: string;
  /** ASS 字幕文件记录 id */
  assFileId?: string;
  /** ASS 字幕下载地址 */
  assUrl?: string;
  /** 成品视频文件记录 id */
  videoFileId?: string;
  /** 成品视频下载地址 */
  videoUrl?: string;
  /** 失败原因 / 状态描述 */
  message?: string;
  /** 提交时间 */
  startedAt?: Date;
  /** 完成时间 */
  finishedAt?: Date;
  /** 提交人（可选） */
  userId?: string;
}

/** 视频生成管道任务 Mongoose Document 类型 */
export type VoicePipelineTaskDocument = BaseDocument & IVoicePipelineTask;

const VoicePipelineTaskSchema = new mongoose.Schema<VoicePipelineTaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed'] as VoicePipelineTaskStatus[],
      default: 'pending',
      index: true,
    },
    text: {
      type: String,
      required: true,
    },
    resId: {
      type: String,
      required: true,
    },
    speed: { type: Number },
    volume: { type: Number },
    pitch: { type: Number },
    language: { type: Number },
    encoding: { type: String },
    sampleRate: { type: Number },
    color: { type: String },
    keywords: { type: [String] },
    audioFileId: { type: String },
    audioUrl: { type: String },
    srtFileId: { type: String },
    srtUrl: { type: String },
    assFileId: { type: String },
    assUrl: { type: String },
    videoFileId: { type: String },
    videoUrl: { type: String },
    message: { type: String, default: '' },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, index: true },
  },
  {
    timestamps: true,
    collection: 'voicePipelineTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, params）
VoicePipelineTaskSchema.plugin(BaseMongoPlugin);

const VoicePipelineTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<VoicePipelineTaskDocument>('VoicePipelineTask', VoicePipelineTaskSchema);

export default VoicePipelineTaskModel;
