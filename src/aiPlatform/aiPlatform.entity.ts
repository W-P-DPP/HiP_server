import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { AIPlatform } from '../../type/index.d.ts';

/** AI 平台配置实体字段（不含 Mongoose Document 方法） */
export interface IAIPlatformAccount extends IBaseMongoEntity {
  /** 归属用户 id（每个用户管理自己的平台配置） */
  userId: string;
  /** 配置名称 */
  name: string;
  /** 平台标识（commandcode / deepseek） */
  provider: AIPlatform.Provider;
  /** 平台 API Key（明文入库，与 wxAccount/dyAccount 现状一致） */
  apiKey: string;
  /** 自定义 baseUrl，空串表示使用平台预设 */
  baseUrl: string;
  /** 默认模型 id */
  defaultModel: string;
  /** 启用/停用 */
  status: AIPlatform.AccountStatus;
}

/** AI 平台配置 Mongoose Document 类型 */
export type AIPlatformAccountDocument = BaseDocument & IAIPlatformAccount;

const AIPlatformAccountSchema = new mongoose.Schema<AIPlatformAccountDocument>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    provider: {
      type: String,
      enum: ['commandcode', 'deepseek'] as AIPlatform.Provider[],
      required: true,
      index: true,
    },
    apiKey: {
      type: String,
      required: true,
    },
    baseUrl: {
      type: String,
      default: '',
      trim: true,
    },
    defaultModel: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'disabled'] as AIPlatform.AccountStatus[],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'aiPlatformAccounts',
  },
);

// 同一用户下配置名称唯一（一个平台可有多条配置；软删 flag:0 行不参与，允许删除后重建）
AIPlatformAccountSchema.index(
  { userId: 1, name: 1 },
  { unique: true, partialFilterExpression: { flag: 1 } },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
AIPlatformAccountSchema.plugin(BaseMongoPlugin);

const AIPlatformAccountModel = MongoDBService.getInstance()
  .getMongoose()
  .model<AIPlatformAccountDocument>('AIPlatformAccount', AIPlatformAccountSchema);

export default AIPlatformAccountModel;
