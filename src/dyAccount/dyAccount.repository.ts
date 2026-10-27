import DyAccountModel, { type DyAccountDocument } from './dyAccount.entity.ts';
import type { DyAccount } from '../../type/index.d.ts';

class DyAccountRepository {
  /** 分页查询抖音应用配置（恒按 userId + flag:1 过滤；用户与应用 1:1，最多一条有效） */
  async findMany(query: DyAccount.Query): Promise<DyAccount.Page<DyAccountDocument>> {
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
        { clientKey: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [list, total] = await Promise.all([
      DyAccountModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      DyAccountModel.countDocuments(filter),
    ]);

    return { list: list as unknown as DyAccountDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 按 id + userId 查找（仅未删除） */
  async findById(id: string, userId: string): Promise<DyAccountDocument | null> {
    return DyAccountModel.findOne({ _id: id, userId, flag: 1 }).exec();
  }

  /** 查找用户的抖音应用配置（用户与应用 1:1，至多一条；不区分启用/停用） */
  async findByUserId(userId: string): Promise<DyAccountDocument | null> {
    return DyAccountModel.findOne({ userId, flag: 1 }).exec();
  }

  /** 查找用户的启用抖音应用配置（用户与应用 1:1，至多一条；getCredential 消费） */
  async findActiveByUserId(userId: string): Promise<DyAccountDocument | null> {
    return DyAccountModel.findOne({ userId, status: 'active', flag: 1 }).exec();
  }

  /** 判断用户是否已配置抖音应用（仅未删除） */
  async existsByUserId(userId: string): Promise<boolean> {
    const doc = await DyAccountModel.exists({ userId, flag: 1 });
    return doc !== null;
  }

  /** 创建抖音应用配置 */
  async create(data: DyAccount.CreateData): Promise<DyAccountDocument> {
    return DyAccountModel.create(data);
  }

  /** 更新（按 id + userId，仅未删除可更新） */
  async updateById(id: string, userId: string, dto: DyAccount.UpdateData): Promise<DyAccountDocument | null> {
    return DyAccountModel.findOneAndUpdate(
      { _id: id, userId, flag: 1 },
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 假删除（按 id + userId）：flag 置 0，不物理删除 */
  async softDeleteById(id: string, userId: string): Promise<boolean> {
    const result = await DyAccountModel.updateOne({ _id: id, userId, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }
}

export const dyAccountRepository = new DyAccountRepository();
