import AIChatConversationModel, { type AIChatConversationDocument } from './aiChatConversation.entity.ts';
import AIChatMessageModel, { type AIChatMessageDocument } from './aiChatMessage.entity.ts';
import type { CreateConversationRecord, ConversationQueryDto, CreateMessageData, MessageQueryDto } from './aiChat.dto.ts';
import type { AIPlatform } from '../../type/index.d.ts';

class AIChatConversationRepository {
  /** 分页查询会话（恒按 userId + flag:1 过滤，按最近活跃倒序） */
  async findMany(userId: string, query: ConversationQueryDto): Promise<AIPlatform.Page<AIChatConversationDocument>> {
    const { accountId, keyword, page = 1, limit = 20 } = query;

    const pageNum = Math.max(1, page);
    const limitNum = Math.min(100, Math.max(1, limit));

    const filter: Record<string, unknown> = { userId, flag: 1 };
    if (accountId) filter.accountId = accountId;
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.title = { $regex: escaped, $options: 'i' };
    }

    const [list, total] = await Promise.all([
      AIChatConversationModel.find(filter)
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      AIChatConversationModel.countDocuments(filter),
    ]);

    return { list: list as unknown as AIChatConversationDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 按 id + userId 查找（仅未删除） */
  async findById(id: string, userId: string): Promise<AIChatConversationDocument | null> {
    return AIChatConversationModel.findOne({ _id: id, userId, flag: 1 }).exec();
  }

  /** 创建会话 */
  async create(data: CreateConversationRecord): Promise<AIChatConversationDocument> {
    return AIChatConversationModel.create(data);
  }

  /** 更新会话（标题/系统提示词等，按 id + userId，仅未删除） */
  async updateById(id: string, userId: string, dto: Partial<CreateConversationRecord>): Promise<AIChatConversationDocument | null> {
    return AIChatConversationModel.findOneAndUpdate(
      { _id: id, userId, flag: 1 },
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 追加一条消息后刷新会话计数与最近活跃时间 */
  async touch(id: string, userId: string, lastMessageAt: Date): Promise<void> {
    await AIChatConversationModel.updateOne(
      { _id: id, userId, flag: 1 },
      { $inc: { messageCount: 1 }, $set: { lastMessageAt } },
    ).exec();
  }

  /** 假删除（按 id + userId）：flag 置 0，不物理删除 */
  async softDeleteById(id: string, userId: string): Promise<boolean> {
    const result = await AIChatConversationModel.updateOne({ _id: id, userId, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }
}

class AIChatMessageRepository {
  /** 落库一条消息 */
  async create(data: CreateMessageData): Promise<AIChatMessageDocument> {
    return AIChatMessageModel.create(data);
  }

  /** 读取会话全部消息（升序，供拼装模型上下文） */
  async findByConversation(conversationId: string): Promise<AIChatMessageDocument[]> {
    return AIChatMessageModel.find({ conversationId, flag: 1 }).sort({ createdAt: 1 }).lean() as unknown as AIChatMessageDocument[];
  }

  /** 分页查询会话消息（升序） */
  async findMany(query: MessageQueryDto): Promise<AIPlatform.Page<AIChatMessageDocument>> {
    const { conversationId, page = 1, limit = 50 } = query;

    const pageNum = Math.max(1, page);
    const limitNum = Math.min(200, Math.max(1, limit));

    const filter = { conversationId, flag: 1 };

    const [list, total] = await Promise.all([
      AIChatMessageModel.find(filter)
        .sort({ createdAt: 1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      AIChatMessageModel.countDocuments(filter),
    ]);

    return { list: list as unknown as AIChatMessageDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 级联假删除某会话的全部消息 */
  async softDeleteByConversation(conversationId: string): Promise<number> {
    const result = await AIChatMessageModel.updateMany({ conversationId, flag: 1 }, { flag: 0 }).exec();
    return result.modifiedCount ?? 0;
  }
}

export const aiChatConversationRepository = new AIChatConversationRepository();
export const aiChatMessageRepository = new AIChatMessageRepository();
