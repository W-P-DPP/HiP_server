import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 订阅状态 */
export type SubscriptionStatus = 'active' | 'cancelled';

/** 订阅实体字段 */
export interface ISubscription extends IBaseMongoEntity {
  userId: string;
  skillKey: string;
  status: SubscriptionStatus;
  subscribedAt: Date;
  cancelledAt: Date | null;
}

/** Subscription Mongoose Document 类型 */
export type SubscriptionDocument = BaseDocument & ISubscription;

const SubscriptionSchema = new mongoose.Schema<SubscriptionDocument>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    skillKey: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'cancelled'] as SubscriptionStatus[],
      default: 'active',
      index: true,
    },
    subscribedAt: {
      type: Date,
      default: Date.now,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: false, // 用 subscribedAt / cancelledAt 替代 createdAt / updatedAt
    collection: 'skill_subscriptions',
  },
);

// 注入基础字段
SubscriptionSchema.plugin(BaseMongoPlugin);

// 复合唯一索引：一个用户对一个 skill 只能有一条 active 订阅
SubscriptionSchema.index(
  { userId: 1, skillKey: 1, status: 1 },
  { unique: true },
);

const SubscriptionModel = MongoDBService.getInstance()
  .getMongoose()
  .model<SubscriptionDocument>('SkillSubscription', SubscriptionSchema);

export default SubscriptionModel;
