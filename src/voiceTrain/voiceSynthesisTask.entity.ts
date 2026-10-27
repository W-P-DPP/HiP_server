import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 音色克隆合成任务状态 */
export type VoiceSynthesisTaskStatus = 'pending' | 'running' | 'success' | 'failed';

/** 音色克隆合成任务实体字段（不含 Mongoose Document 方法） */
export interface IVoiceSynthesisTask extends IBaseMongoEntity {
  status: VoiceSynthesisTaskStatus;
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
  /** 音频编码 */
  encoding?: string;
  /** 采样率 */
  sampleRate?: number;
  /** 合成成功后的文件记录 id */
  resultFileId?: string;
  /** 合成成功后的下载地址 */
  resultUrl?: string;
  /** 失败原因 / 状态描述 */
  message?: string;
  /** 提交时间 */
  startedAt?: Date;
  /** 完成时间 */
  finishedAt?: Date;
  /** 提交人（可选） */
  userId?: string;
}

/** 音色克隆合成任务 Mongoose Document 类型 */
export type VoiceSynthesisTaskDocument = BaseDocument & IVoiceSynthesisTask;

const VoiceSynthesisTaskSchema = new mongoose.Schema<VoiceSynthesisTaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed'] as VoiceSynthesisTaskStatus[],
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
    resultFileId: { type: String },
    resultUrl: { type: String },
    message: { type: String, default: '' },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, index: true },
  },
  {
    timestamps: true,
    collection: 'voiceSynthesisTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, params）
VoiceSynthesisTaskSchema.plugin(BaseMongoPlugin);

const VoiceSynthesisTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<VoiceSynthesisTaskDocument>('VoiceSynthesisTask', VoiceSynthesisTaskSchema);

export default VoiceSynthesisTaskModel;
