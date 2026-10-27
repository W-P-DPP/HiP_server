import AIPlatformAccountModel, { type AIPlatformAccountDocument } from './aiPlatform.entity.ts';
import type { AIPlatform } from '../../type/index.d.ts';

class AIPlatformRepository {
  /** 分页查询平台配置（恒按 userId + flag:1 过滤） */
  async findMany(query: AIPlatform.AccountQuery): Promise<AIPlatform.Page<AIPlatformAccountDocument>> {
    const { userId, provider, status, keyword, page = 1, limit = 20 } = query;

    const pageNum = Math.max(1, page);
    const limitNum = Math.min(100, Math.max(1, limit));

    const filter: Record<string, unknown> = { userId, flag: 1 };

    if (provider) {
      filter.provider = provider;
    }
    if (status) {
      filter.status = status;
    }
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { defaultModel: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [list, total] = await Promise.all([
      AIPlatformAccountModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      AIPlatformAccountModel.countDocuments(filter),
    ]);

    return { list: list as unknown as AIPlatformAccountDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 按 id + userId 查找（仅未删除） */
  async findById(id: string, userId: string): Promise<AIPlatformAccountDocument | null> {
    return AIPlatformAccountModel.findOne({ _id: id, userId, flag: 1 }).exec();
  }

  /** 判断用户是否已存在同名配置（仅未删除） */
  async existsByUserAndName(userId: string, name: string): Promise<boolean> {
    const doc = await AIPlatformAccountModel.exists({ userId, name, flag: 1 });
    return doc !== null;
  }

  /** 创建平台配置 */
  async create(data: AIPlatform.AccountCreateData): Promise<AIPlatformAccountDocument> {
    return AIPlatformAccountModel.create(data);
  }

  /** 更新（按 id + userId，仅未删除可更新） */
  async updateById(id: string, userId: string, dto: AIPlatform.AccountUpdateData): Promise<AIPlatformAccountDocument | null> {
    return AIPlatformAccountModel.findOneAndUpdate(
      { _id: id, userId, flag: 1 },
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 假删除（按 id + userId）：flag 置 0，不物理删除 */
  async softDeleteById(id: string, userId: string): Promise<boolean> {
    const result = await AIPlatformAccountModel.updateOne({ _id: id, userId, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }
}

export const aiPlatformRepository = new AIPlatformRepository();
