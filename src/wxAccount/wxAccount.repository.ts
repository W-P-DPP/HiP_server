import WxAccountModel, { type WxAccountDocument } from './wxAccount.entity.ts';
import type { WxAccount } from '../../type/index.d.ts';

class WxAccountRepository {
  /** 分页查询公众号配置（恒按 userId + flag:1 过滤；用户与公众号 1:1，最多一条有效） */
  async findMany(query: WxAccount.Query): Promise<WxAccount.Page<WxAccountDocument>> {
    const { userId, status, keyword, page = 1, limit = 20 } = query;

    const pageNum = Math.max(1, page);
    const limitNum = Math.min(100, Math.max(1, limit));

    const filter: Record<string, unknown> = { userId, flag: 1 };

    if (status) {
      filter.status = status;
    }
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { appId: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [list, total] = await Promise.all([
      WxAccountModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      WxAccountModel.countDocuments(filter),
    ]);

    return { list: list as unknown as WxAccountDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 按 id + userId 查找（仅未删除） */
  async findById(id: string, userId: string): Promise<WxAccountDocument | null> {
    return WxAccountModel.findOne({ _id: id, userId, flag: 1 }).exec();
  }

  /** 查找用户的启用公众号配置（用户与公众号 1:1，至多一条；getCredential 消费） */
  async findActiveByUserId(userId: string): Promise<WxAccountDocument | null> {
    return WxAccountModel.findOne({ userId, status: 'active', flag: 1 }).exec();
  }

  /** 判断用户是否已配置公众号（仅未删除） */
  async existsByUserId(userId: string): Promise<boolean> {
    const doc = await WxAccountModel.exists({ userId, flag: 1 });
    return doc !== null;
  }

  /** 创建公众号配置 */
  async create(data: WxAccount.CreateData): Promise<WxAccountDocument> {
    return WxAccountModel.create(data);
  }

  /** 更新（按 id + userId，仅未删除可更新） */
  async updateById(id: string, userId: string, dto: WxAccount.UpdateData): Promise<WxAccountDocument | null> {
    return WxAccountModel.findOneAndUpdate(
      { _id: id, userId, flag: 1 },
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 假删除（按 id + userId）：flag 置 0，不物理删除 */
  async softDeleteById(id: string, userId: string): Promise<boolean> {
    const result = await WxAccountModel.updateOne({ _id: id, userId, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }
}

export const wxAccountRepository = new WxAccountRepository();
