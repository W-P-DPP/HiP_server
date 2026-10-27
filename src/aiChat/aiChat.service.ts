import { aiChatConversationRepository, aiChatMessageRepository } from './aiChat.repository.ts';
import type { AIChatConversationDocument } from './aiChatConversation.entity.ts';
import type { AIChatMessageDocument } from './aiChatMessage.entity.ts';
import type { CreateConversationDto, ConversationQueryDto, MessageQueryDto, PreparedChat } from './aiChat.dto.ts';
import { aiPlatformService } from '../aiPlatform/aiPlatform.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import type { AIPlatform } from '../../type/index.d.ts';

/** 会话默认标题（与实体 default 保持一致，用于判断是否首轮自动命名） */
const DEFAULT_TITLE = '新对话';
/** 首轮自动命名时截取的标题长度 */
const TITLE_MAX_LENGTH = 20;

class AIChatService {
  /** 创建会话（引用一个启用中的平台配置，快照 provider/model） */
  async createConversation(
    userId: string,
    dto: CreateConversationDto,
  ): Promise<{ created: AIChatConversationDocument } | { error: string; code: number }> {
    const account = await aiPlatformService.getById(userId, dto.accountId);
    if ('error' in account) {
      return { error: 'AI 平台配置不存在', code: HttpStatus.NOT_FOUND };
    }
    if (account.account.status !== 'active') {
      return { error: 'AI 平台配置已停用', code: HttpStatus.CONFLICT };
    }

    const modelName = dto.model?.trim() || account.account.defaultModel;
    const created = await aiChatConversationRepository.create({
      userId,
      accountId: dto.accountId,
      provider: account.account.provider,
      ...(dto.title ? { title: dto.title } : {}),
      ...(dto.systemPrompt ? { systemPrompt: dto.systemPrompt } : {}),
      modelName,
    });
    return { created };
  }

  /** 分页查询会话（恒按当前用户隔离） */
  async listConversations(userId: string, query: ConversationQueryDto): Promise<AIPlatform.Page<AIChatConversationDocument>> {
    return aiChatConversationRepository.findMany(userId, { ...query, userId });
  }

  /** 获取单个会话 */
  async getConversation(userId: string, id: string): Promise<{ conversation: AIChatConversationDocument } | { error: string }> {
    const conversation = await aiChatConversationRepository.findById(id, userId);
    if (!conversation) {
      return { error: '会话不存在' };
    }
    return { conversation };
  }

  /** 分页查询会话消息（先校验会话归属） */
  async listMessages(
    userId: string,
    conversationId: string,
    query: MessageQueryDto,
  ): Promise<{ page: AIPlatform.Page<AIChatMessageDocument> } | { error: string }> {
    const conversation = await aiChatConversationRepository.findById(conversationId, userId);
    if (!conversation) {
      return { error: '会话不存在' };
    }
    const page = await aiChatMessageRepository.findMany({ ...query, userId, conversationId });
    return { page };
  }

  /** 删除会话（假删除 + 级联假删除消息） */
  async deleteConversation(userId: string, id: string): Promise<{ error?: string }> {
    const conversation = await aiChatConversationRepository.findById(id, userId);
    if (!conversation) {
      return { error: '会话不存在' };
    }

    await aiChatConversationRepository.softDeleteById(id, userId);
    await aiChatMessageRepository.softDeleteByConversation(id);
    return {};
  }

  /**
   * 准备一轮对话：校验凭证 → 落库用户消息 → 拼装模型上下文。
   * 失败分支带 code，供 SSE 接口在写响应头之前翻成普通 ResultVO 信封。
   */
  async prepareChat(
    userId: string,
    conversationId: string,
    dto: AIPlatform.ChatRequest,
  ): Promise<{ prepared: PreparedChat } | { error: string; code: number }> {
    const conversation = await aiChatConversationRepository.findById(conversationId, userId);
    if (!conversation) {
      return { error: '会话不存在', code: HttpStatus.NOT_FOUND };
    }

    const resolved = await aiPlatformService.resolveCredential(userId, conversation.accountId);
    if ('error' in resolved) {
      return { error: resolved.error, code: resolved.code };
    }

    // 先落库用户消息（并刷新会话计数/活跃时间），再读全量历史（含本轮输入）拼装上下文，保证顺序一致
    await aiChatMessageRepository.create({
      conversationId,
      userId,
      role: 'user',
      content: dto.content,
    });
    await aiChatConversationRepository.touch(conversationId, userId, new Date());

    // 首轮自动命名：标题仍为默认且尚无已完成消息时，用本轮输入截取
    if (conversation.title === DEFAULT_TITLE && conversation.messageCount === 0) {
      const title = dto.content.trim().slice(0, TITLE_MAX_LENGTH) || DEFAULT_TITLE;
      await aiChatConversationRepository.updateById(conversationId, userId, { title });
    }

    // 排除失败的助手消息：它们是半截片段（可能为空），喂回模型会污染上下文
    const history = (await aiChatMessageRepository.findByConversation(conversationId)).filter(
      (m) => m.role !== 'assistant' || m.status === 'success',
    );
    const messages: AIPlatform.ChatMessage[] = [
      ...(conversation.systemPrompt ? [{ role: 'system' as const, content: conversation.systemPrompt }] : []),
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    return {
      prepared: {
        conversationId,
        model: dto.model?.trim() || conversation.modelName,
        messages,
        credential: resolved.credential,
      },
    };
  }

  /**
   * 落库助手回复（成功/失败都落库，失败保留已生成片段与错误原因），并刷新会话计数。
   */
  async appendAssistantMessage(
    userId: string,
    conversationId: string,
    data: { content: string; model: string; status: AIPlatform.MessageStatus; error?: string; tokens?: number },
  ): Promise<AIChatMessageDocument> {
    const created = await aiChatMessageRepository.create({
      conversationId,
      userId,
      role: 'assistant',
      content: data.content,
      modelName: data.model,
      status: data.status,
      error: data.error ?? '',
      tokens: data.tokens ?? 0,
    });

    await aiChatConversationRepository.touch(conversationId, userId, new Date());
    return created;
  }
}

export const aiChatService = new AIChatService();
