import { Types } from 'mongoose';
import UserModel, { type UserDocument } from './user.entity.ts';
import type { RegisterDto } from './user.dto.ts';
import type { User } from '../../type/index.d.ts';

/** 更新用户的可写字段（不含 account；password 传 bcrypt 哈希） */
export type UpdateUserData = Partial<Pick<UserDocument, 'nickname' | 'avatar' | 'role' | 'password'>>;

/** 创建/恢复用户的可写数据（parentId 可选 → Schema default null；role 可选 → Schema default user） */
export type CreateUserData = RegisterDto & { parentId?: Types.ObjectId | null; role?: User.Role };

class UserRepository {
  /** 按账号查找（仅未删除，默认投影不含密码） */
  async findByAccount(account: string): Promise<UserDocument | null> {
    return UserModel.findOne({ account, flag: 1 }).exec();
  }

  /** 按账号查找（仅未删除，显式带出密码哈希，仅登录比对用） */
  async findByAccountWithPassword(account: string): Promise<UserDocument | null> {
    return UserModel.findOne({ account, flag: 1 }).select('+password').exec();
  }

  /** 判断账号是否已存在（仅未删除） */
  async existsByAccount(account: string): Promise<boolean> {
    const doc = await UserModel.exists({ account, flag: 1 });
    return doc !== null;
  }

  /** 按 id 查找（仅未删除） */
  async findById(id: string): Promise<UserDocument | null> {
    return UserModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /** 按 _id 更新（仅未删除才可更新，返回更新后文档） */
  async updateById(id: string, data: UpdateUserData): Promise<UserDocument | null> {
    return UserModel.findOneAndUpdate(
      { _id: id, flag: 1 },
      { $set: data },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 按 _id 假删除（仅未删除才可删除） */
  async softDeleteById(id: string): Promise<boolean> {
    const result = await UserModel.updateOne({ _id: id, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  /** 创建用户 */
  async create(dto: CreateUserData): Promise<UserDocument> {
    return UserModel.create(dto);
  }

  /** 未删除用户总数（统计用） */
  async countAll(): Promise<number> {
    return UserModel.countDocuments({ flag: 1 });
  }

  /** 指定时刻起注册的未删除用户数（统计新增用，createdAt >= since） */
  async countCreatedSince(since: Date): Promise<number> {
    return UserModel.countDocuments({ flag: 1, createdAt: { $gte: since } });
  }

  /**
   * 按本地自然日分组的未删除用户新增数（统计「近半个月每日新增」用，createdAt >= since）。
   * $dateToString 显式带时区，避免 Mongo 默认按 UTC 切日与本地（东八区）日期错位；
   * 返回按日期字符串聚合的原始行，缺日补 0 由 service 负责。
   */
  async countDailyCreatedSince(
    since: Date,
    timezone: string,
  ): Promise<{ date: string; count: number }[]> {
    const rows = await UserModel.aggregate<{ _id: string; count: number }>([
      { $match: { flag: 1, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } },
          count: { $sum: 1 },
        },
      },
    ]).exec();
    return rows.map((row) => ({ date: row._id, count: row.count }));
  }

  /** 按角色分组的未删除用户数（统计用，仅返回有数据的角色，缺省角色由 service 补 0） */
  async countGroupByRole(): Promise<{ role: User.Role; count: number }[]> {
    const rows = await UserModel.aggregate<{ _id: User.Role; count: number }>([
      { $match: { flag: 1 } },
      { $group: { _id: '$role', count: { $sum: 1 } } },
    ]).exec();
    return rows.map((row) => ({ role: row._id, count: row.count }));
  }

  /** 恢复已假删除的用户（按账号，flag 置回 1，并重置密码哈希与父级） */
  async restoreByAccount(account: string, dto: CreateUserData): Promise<UserDocument | null> {
    return UserModel.findOneAndUpdate(
      { account, flag: 0 },
      { $set: { ...dto, flag: 1 } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 查 rootId 的全部后代文档（全层级、仅未删除、无分页），供 service 在 JS 侧按 parentId 组装递归树。
   * 用单条 $graphLookup 自父向子递归；聚合不认 select:false，故用包含式 $project 白名单防密码外泄。
   * 注意：graphLookup 结果不含根自身，直接子节点从 depth 0 起，因此不可再加 depth>0 过滤，否则会丢一级子用户。
   */
  async findDescendantDocs(rootId: Types.ObjectId): Promise<UserDocument[]> {
    // Mongoose v9 的 PipelineStage[] 联合类型过严、无法容纳动态拼装，此处放宽为 any[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline: any[] = [
      { $match: { _id: rootId, flag: 1 } },
      {
        $graphLookup: {
          from: UserModel.collection.name,
          startWith: '$_id',
          connectFromField: '_id', // 方向：向下找后代
          connectToField: 'parentId', // 命中“谁是子节点”
          as: 'desc',
          restrictSearchWithMatch: { flag: 1 },
          maxDepth: 100, // 防意外成环
        },
      },
      { $unwind: '$desc' },
      { $replaceRoot: { newRoot: '$desc' } },
      {
        $project: {
          _id: 1,
          account: 1,
          nickname: 1,
          avatar: 1,
          role: 1,
          parentId: 1,
          createdAt: 1,
        },
      },
    ];

    return (await UserModel.aggregate<Record<string, unknown>>(pipeline).exec()) as unknown as UserDocument[];
  }
}

export const userRepository = new UserRepository();
