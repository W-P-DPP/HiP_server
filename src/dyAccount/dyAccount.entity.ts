import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 抖音应用状态 */
export type DyAccountStatus = 'active' | 'disabled';

/** 抖音应用配置实体字段（不含 Mongoose Document 方法） */
export interface IDyAccount extends IBaseMongoEntity {
  /** 归属用户 id（每个用户管理自己的抖音应用配置） */
  userId: string;
  /** 应用名称 */
  name: string;
  /** 抖音开放平台 ClientKey */
  clientKey: string;
  /** 抖音开放平台 ClientSecret（明文入库，与项目现状一致） */
  clientSecret: string;
  /** 启用/停用 */
  status: DyAccountStatus;
}

/** 抖音应用配置 Mongoose Document 类型 */
export type DyAccountDocument = BaseDocument & IDyAccount;

const DyAccountSchema = new mongoose.Schema<DyAccountDocument>(
  {
    userId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    clientKey: {
      type: String,
      required: true,
      trim: true,
    },
    clientSecret: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'disabled'] as DyAccountStatus[],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'dyAccounts',
  },
);

// 用户与抖音应用一一对应：同用户仅一条未删除配置（软删 flag:0 行不参与，允许删除后重建）
DyAccountSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { flag: 1 } },
);

// 注入基础字段（createBy, updateBy, remark, params）
DyAccountSchema.plugin(BaseMongoPlugin);

const DyAccountModel = MongoDBService.getInstance()
  .getMongoose()
  .model<DyAccountDocument>('DyAccount', DyAccountSchema);

export default DyAccountModel;
