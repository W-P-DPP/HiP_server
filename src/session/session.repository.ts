import SessionModel, { type SessionDocument } from './session.entity.ts';
import type { UuidManage } from '../../type/index.d.ts';

class SessionRepository {
  /** 创建 Session */
  async create(data: UuidManage.CreateData): Promise<SessionDocument> {
    return SessionModel.create(data);
  }

  /** 按  uuid 查找） */
  async findByUuid( uuid: string): Promise<SessionDocument | null> {
    return SessionModel.findOne({
      uuid,
      flag: 1,
    }).exec();
  }

  /**
   * 原子状态迁移：仅 active 且未过期时变更状态（Mongo findAndModify 原子性，杜绝并发双消费）
   * 返回更新后的文档；未命中返回 null（不存在 / 非 active / 已过期，原因由调用方二次查询区分）
   */
  async transition(userId: string, uuid: string, target: UuidManage.Status): Promise<SessionDocument | null> {
    return SessionModel.findOneAndUpdate(
      {
        userId,
        uuid,
        status: 'active',
        flag: 1,
        $or: [{ expireAt: null }, { expireAt: { $gt: new Date() } }],
      },
      { $set: { status: target } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 按 _id 查找（管理视角，含已过期；未删除） */
  async findById(id: string): Promise<SessionDocument | null> {
    return SessionModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /** 按 _id 更新（未删除才可更新） */
  async updateById(id: string, dto: Partial<UuidManage.CreateData>): Promise<SessionDocument | null> {
    return SessionModel.findOneAndUpdate(
      { _id: id, flag: 1 },
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 按 _id 假删除 */
  async softDeleteById(id: string): Promise<boolean> {
    const result = await SessionModel.updateOne({ _id: id, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  /** 分页查询用户 Session（默认仅未过期、未删除；includeExpired=true 时含已过期） */
  async findMany(query: UuidManage.Query): Promise<UuidManage.Page<SessionDocument>> {
    const { userId, status, scene, name, keyword, includeExpired = false, page = 1, limit = 20 } = query;

    const pageNum = Math.max(1, page);
    const limitNum = Math.min(100, Math.max(1, limit));

    const filter: Record<string, unknown> = {
      flag: 1,
    };

    if (!includeExpired) {
      filter.$or = [{ expireAt: null }, { expireAt: { $gt: new Date() } }];
    }
    if (userId) {
      filter.userId = userId;
    }
    if (status) {
      filter.status = status;
    }
    if (scene) {
      filter.scene = scene;
    }
    if (name) {
      filter.name = { $regex: SessionRepository.escapeRegex(name), $options: 'i' };
    }
    if (keyword) {
      const escaped = SessionRepository.escapeRegex(keyword);
      filter.$and = [
        {
          $or: [
            { uuid: { $regex: escaped, $options: 'i' } },
            { name: { $regex: escaped, $options: 'i' } },
          ],
        },
      ];
    }

    const [list, total] = await Promise.all([
      SessionModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      SessionModel.countDocuments(filter),
    ]);

    return { list: list as unknown as SessionDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 转义正则元字符，避免 keyword 作为正则表达式被解析 */
  private static escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export const sessionRepository = new SessionRepository();
