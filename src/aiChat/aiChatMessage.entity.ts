import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { AIPlatform } from '../../type/index.d.ts';

/** AI 对话消息实体字段（不含 Mongoose Document 方法） */
export interface IAIChatMessage extends IBaseMongoEntity {
  /** 所属会话 id */
  conversationId: string;
  /** 归属用户 id */
  userId: string;
  /** 角色 */
  role: AIPlatform.ChatRole;
  /** 消息内容（失败的助手消息保留已生成片段） */
  content: string;
  /** 生成该条消息所用模型（助手消息填写）。注意不能叫 model：与 Document.model() 冲突 */
  modelName: string;
  /** 助手消息落库状态（user 消息恒为 success） */
  status: AIPlatform.MessageStatus;
  /** 失败原因（status=failed 时填写） */
  error: string;
  /** 上游返回的补全 token 数（缺省 0） */
  tokens: number;
}

/** AI 对话消息 Mongoose Document 类型 */
export type AIChatMessageDocument = BaseDocument & IAIChatMessage;

const AIChatMessageSchema = new mongoose.Schema<AIChatMessageDocument>(
  {
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['system', 'user', 'assistant'] as AIPlatform.ChatRole[],
      required: true,
    },
    content: {
      type: String,
      default: '',
    },
    modelName: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['success', 'failed'] as AIPlatform.MessageStatus[],
      default: 'success',
    },
    error: {
      type: String,
      default: '',
    },
    tokens: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    collection: 'aiChatMessages',
  },
);

// 按会话升序读取（拼装对话上下文 / 历史分页）
AIChatMessageSchema.index({ conversationId: 1, createdAt: 1 });

// 注入基础字段（createBy, updateBy, remark, flag, params）
AIChatMessageSchema.plugin(BaseMongoPlugin);

const AIChatMessageModel = MongoDBService.getInstance()
  .getMongoose()
  .model<AIChatMessageDocument>('AIChatMessage', AIChatMessageSchema);

export default AIChatMessageModel;
