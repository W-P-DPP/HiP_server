import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 音色训练结果落库字段（XunfeiTrainResultDto + taskId + userId） */
export interface IVoiceTrainResult extends IBaseMongoEntity {
  /** 讯飞训练任务 id（查询训练结果用，upsert 唯一键） */
  taskId: string;
  /** 任务名称 */
  taskName: string;
  /** 音色资源名称 */
  resourceName: string;
  /** 音库 id */
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
  /** 性别：0 女 / 1 男 */
  sex: number;
  /** 训练状态（透传讯飞值）：-1 训练中 / 0 失败 / 1 成功 / 2 排队中；本地新建记录初始化为 -1 */
  trainStatus: number;
  /** 年龄段 */
  ageGroup: number;
  /** 训练文本段落 ID */
  textSegId: string;
  /** 文本 ID */
  textId: string;
  /** 归属用户 */
  userId?: string;
}

/** 音色训练结果 Mongoose Document 类型 */
export type VoiceTrainResultDocument = BaseDocument & IVoiceTrainResult;

const VoiceTrainResultSchema = new mongoose.Schema<VoiceTrainResultDocument>(
  {
    taskId: {
      type: String,
      required: true,
    },
    taskName: { type: String, default: '' },
    resourceName: { type: String, default: '' },
    trainVid: { type: String, default: '' },
    trainVcn: { type: String, default: '' },
    assetId: { type: String, default: '' },
    trainId: { type: String, default: '' },
    appId: { type: String, default: '' },
    failedDesc: { type: String, default: '' },
    sex: { type: Number, default: 0 },
    trainStatus: { type: Number, default: -1 },
    ageGroup: { type: Number, default: 0 },
    textSegId: { type: String, default: '' },
    textId: { type: String, default: '' },
    userId: { type: String, index: true },
  },
  {
    timestamps: true,
    collection: 'voiceTrainResults',
  },
);

// 注入基础字段（createBy, updateBy, remark, params）
VoiceTrainResultSchema.plugin(BaseMongoPlugin);

// taskId 唯一索引：upsert 依据，保证轮询不产生重复记录
VoiceTrainResultSchema.index({ taskId: 1 }, { unique: true });

const VoiceTrainResultModel = MongoDBService.getInstance()
  .getMongoose()
  .model<VoiceTrainResultDocument>('VoiceTrainResult', VoiceTrainResultSchema);

export default VoiceTrainResultModel;
