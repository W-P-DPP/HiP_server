import SubscriptionModel, { type SubscriptionDocument, type SubscriptionStatus } from './subscription.entity.ts';

class SubscriptionRepository {
  /** 查询用户订阅列表（仅未删除） */
  async findByUser(
    userId: string,
    status: SubscriptionStatus = 'active',
  ): Promise<SubscriptionDocument[]> {
    return SubscriptionModel.find({ userId, status, flag: 1 }).lean() as unknown as SubscriptionDocument[];
  }

  /** 查找用户对某 skill 的活跃订阅（仅未删除） */
  async findActive(userId: string, skillKey: string): Promise<SubscriptionDocument | null> {
    return SubscriptionModel.findOne({ userId, skillKey, status: 'active', flag: 1 }).exec();
  }

  /** 创建订阅 */
  async create(userId: string, skillKey: string): Promise<SubscriptionDocument> {
    return SubscriptionModel.create({ userId, skillKey });
  }

  /** 刷新订阅时间（重复订阅时更新） */
  async renew(userId: string, skillKey: string): Promise<SubscriptionDocument | null> {
    return SubscriptionModel.findOneAndUpdate(
      { userId, skillKey, status: 'active' },
      { $set: { subscribedAt: new Date() } },
      { returnDocument: 'after' },
    ).exec();
  }

  /** 取消订阅 */
  async cancel(userId: string, skillKey: string): Promise<SubscriptionDocument | null> {
    // 假删除特例（见 docs/代码规范.md §4.4）：清理旧的已取消记录，避免 (userId, skillKey, 'cancelled') 唯一索引冲突，
    // 属唯一索引数据卫生特例，允许物理删除
    await SubscriptionModel.deleteMany({ userId, skillKey, status: 'cancelled' });

    return SubscriptionModel.findOneAndUpdate(
      { userId, skillKey, status: 'active' },
      { $set: { status: 'cancelled', cancelledAt: new Date() } },
      { returnDocument: 'after' },
    ).exec();
  }

  /** 取消某 skill 的所有活跃订阅（级联删除 skill 时使用） */
  async cancelAllForSkill(skillKey: string): Promise<void> {
    await SubscriptionModel.updateMany(
      { skillKey, status: 'active' },
      { $set: { status: 'cancelled', cancelledAt: new Date() } },
    ).exec();
  }
}

export const subscriptionRepository = new SubscriptionRepository();
