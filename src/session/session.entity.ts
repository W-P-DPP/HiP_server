import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { UuidManage } from '../../type/index.d.ts';

/** Session 实体字段（不含 Mongoose Document 方法） */
export interface ISession extends IBaseMongoEntity {
  /** 关联用户 id */
  userId: string;
  /** 签发标识（唯一） */
  uuid: string;
  /** 业务场景 */
  scene?: string;
  /** 会话名称（必填，内部签发默认取 scene） */
  name: string;
  /** 签发状态 */
  status: UuidManage.Status;
  /** 签发 TTL（秒）；null = 永不过期 */
  ttl: number | null;
  /** 过期时间；null = 永不过期 */
  expireAt: Date | null;
}

/** Session Mongoose Document 类型 */
export type SessionDocument = BaseDocument & ISession;

const SessionSchema = new mongoose.Schema<SessionDocument>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    uuid: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    scene: {
      type: String,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'used', 'revoked'] as UuidManage.Status[],
      default: 'active',
      index: true,
    },
    ttl: {
      type: Number,
      default: null,
    },
    expireAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'sessions',
  },
);

// TTL 索引：到期的 session 自动清理（expireAt 为 null 的文档不参与删除，天然实现「永不过期」）
SessionSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// 注入基础字段（createBy, updateBy, remark, flag, params）
SessionSchema.plugin(BaseMongoPlugin);

const SessionModel = MongoDBService.getInstance()
  .getMongoose()
  .model<SessionDocument>('Session', SessionSchema);

export default SessionModel;
