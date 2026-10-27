import type { AIPlatform } from '../../type/index.d.ts';

/** 创建会话入参（客户端） */
export type CreateConversationDto = AIPlatform.ConversationCreateData;

/** 落库会话入参（在客户端入参基础上补 provider/model 快照，repository 内部用） */
export interface CreateConversationRecord {
  userId: string;
  accountId: string;
  provider: AIPlatform.Provider;
  title?: string;
  systemPrompt?: string;
  /** 会话默认模型（快照自平台配置或请求覆盖） */
  modelName: string;
}

/** 会话查询参数（userId 恒为当前登录用户） */
export type ConversationQueryDto = AIPlatform.ConversationQuery;

/** 消息查询参数 */
export type MessageQueryDto = AIPlatform.MessageQuery;

/** 发起对话入参 */
export type ChatRequestDto = AIPlatform.ChatRequest;

/** 落库一条消息的入参（repository 内部用） */
export interface CreateMessageData {
  conversationId: string;
  userId: string;
  role: AIPlatform.ChatRole;
  content: string;
  modelName?: string;
  status?: AIPlatform.MessageStatus;
  error?: string;
  tokens?: number;
}

/** 会话准备结果：拼装好的模型上下文 + 调用凭证 */
export interface PreparedChat {
  conversationId: string;
  model: string;
  messages: AIPlatform.ChatMessage[];
  credential: AIPlatform.Credential;
}
