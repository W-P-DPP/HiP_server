import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 微信公众号状态 */
export type WxAccountStatus = 'active' | 'disabled';

/** 微信公众号配置实体字段（不含 Mongoose Document 方法） */
export interface IWxAccount extends IBaseMongoEntity {
  /** 归属用户 id（每个用户管理自己的公众号配置） */
  userId: string;
  /** 公众号名称 */
  name: string;
  /** 公众号 AppID */
  appId: string;
  /** 公众号 AppSecret（明文入库，与项目现状一致） */
  appSecret: string;
  /** 服务器配置 Token（微信签名校验用） */
  token: string;
  /** 消息加解密密钥 */
  encodingAESKey: string;
  /** 启用/停用 */
  status: WxAccountStatus;
}

/** 微信公众号配置 Mongoose Document 类型 */
export type WxAccountDocument = BaseDocument & IWxAccount;

const WxAccountSchema = new mongoose.Schema<WxAccountDocument>(
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
    appId: {
      type: String,
      required: true,
      trim: true,
    },
    appSecret: {
      type: String,
      required: true,
    },
    token: {
      type: String,
      required: true,
    },
    encodingAESKey: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'disabled'] as WxAccountStatus[],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'wxAccounts',
  },
);

// 用户与公众号一一对应：同用户仅一条未删除配置（软删 flag:0 行不参与，允许删除后重建）
WxAccountSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { flag: 1 } },
);

// 注入基础字段（createBy, updateBy, remark, params）
WxAccountSchema.plugin(BaseMongoPlugin);

const WxAccountModel = MongoDBService.getInstance()
  .getMongoose()
  .model<WxAccountDocument>('WxAccount', WxAccountSchema);

export default WxAccountModel;
