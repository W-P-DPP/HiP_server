import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** OAuthClient 实体字段（不含 Mongoose Document 方法） */
export interface IOAuthClient extends IBaseMongoEntity {
  /** 动态注册的 client_id（查找键） */
  clientId: string;
  /** 完整 OAuthClientInformationFull（snake_case，JSON-safe），Mixed 原样存取 */
  data: Record<string, unknown>;
}

/** OAuthClient Mongoose Document 类型 */
export type OAuthClientDocument = BaseDocument & IOAuthClient;

const OAuthClientSchema = new mongoose.Schema<OAuthClientDocument>(
  {
    clientId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: true,
    collection: 'oauthclients',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
OAuthClientSchema.plugin(BaseMongoPlugin);

const OAuthClientModel = MongoDBService.getInstance()
  .getMongoose()
  .model<OAuthClientDocument>('OAuthClient', OAuthClientSchema);

export default OAuthClientModel;
