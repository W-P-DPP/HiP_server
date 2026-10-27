import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { AIPlatform } from '../../type/index.d.ts';

/** AI 对话会话实体字段（不含 Mongoose Document 方法） */
export interface IAIChatConversation extends IBaseMongoEntity {
  /** 归属用户 id */
  userId: string;
  /** 引用的平台配置 id（快照，配置删除后历史仍可读） */
  accountId: string;
  /** 平台标识快照 */
  provider: AIPlatform.Provider;
  /** 会话标题（首轮输入自动截取，缺省「新对话」） */
  title: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 会话默认模型（创建时取平台配置 defaultModel，可被请求覆盖）。注意不能叫 model：与 Document.model() 冲突 */
  modelName: string;
  /** 消息条数（user + assistant） */
  messageCount: number;
  /** 最后一条消息时间 */
  lastMessageAt: Date | null;
}

/** AI 对话会话 Mongoose Document 类型 */
export type AIChatConversationDocument = BaseDocument & IAIChatConversation;

const AIChatConversationSchema = new mongoose.Schema<AIChatConversationDocument>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    accountId: {
      type: String,
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ['commandcode', 'deepseek'] as AIPlatform.Provider[],
      required: true,
    },
    title: {
      type: String,
      default: '新对话',
      trim: true,
    },
    systemPrompt: {
      type: String,
      default: '',
    },
    modelName: {
      type: String,
      required: true,
      trim: true,
    },
    messageCount: {
      type: Number,
      default: 0,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'aiChatConversations',
  },
);

// 会话列表按最近活跃倒序
AIChatConversationSchema.index({ userId: 1, lastMessageAt: -1 });

// 注入基础字段（createBy, updateBy, remark, flag, params）
AIChatConversationSchema.plugin(BaseMongoPlugin);

const AIChatConversationModel = MongoDBService.getInstance()
  .getMongoose()
  .model<AIChatConversationDocument>('AIChatConversation', AIChatConversationSchema);

export default AIChatConversationModel;
