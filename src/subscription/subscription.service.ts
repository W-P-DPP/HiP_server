import { subscriptionRepository } from './subscription.repository.ts';
import { skillRepository } from '../skill/skill.repository.ts';
import type { SubscriptionDocument, SubscriptionStatus } from './subscription.entity.ts';

class SubscriptionService {
  /** 获取用户订阅列表（含 Skill 详情） */
  async getByUser(userId: string, status?: string) {
    const subs = await subscriptionRepository.findByUser(userId, (status as SubscriptionStatus) || 'active');
    const skillKeys = [...new Set(subs.map(s => s.skillKey))];
    const skills = await skillRepository.findByKeys(skillKeys);
    const skillMap = new Map(skills.map(s => [s.key, s]));

    const subscriptions = subs.map(sub => ({
      ...sub,
      skill: skillMap.get(sub.skillKey) || null,
    }));

    return { subscriptions, total: subscriptions.length };
  }

  /** 检查是否已订阅 */
  async check(userId: string, skillKey: string) {
    const sub = await subscriptionRepository.findActive(userId, skillKey);
    return { subscribed: !!sub, subscription: sub };
  }

  /** 订阅 */
  async subscribe(userId: string, skillKey: string): Promise<{ subscription?: SubscriptionDocument; error?: string; renewed?: boolean }> {
    // 验证 skill 存在且活跃
    const skill = await skillRepository.findByKey(skillKey);
    if (!skill || skill.status !== 'active') {
      return { error: 'Skill 不存在或已下线' };
    }

    // 检查是否已订阅，已订阅则刷新订阅时间
    const existing = await subscriptionRepository.findActive(userId, skillKey);
    if (existing) {
      const renewed = await subscriptionRepository.renew(userId, skillKey);
      const result: { subscription?: SubscriptionDocument; error?: string; renewed?: boolean } = { renewed: true };
      if (renewed) result.subscription = renewed;
      return result;
    }

    const subscription = await subscriptionRepository.create(userId, skillKey);
    // 原子增加下载数
    await skillRepository.incrementDownloadCount(skillKey);

    return { subscription, renewed: false };
  }

  /** 取消订阅 */
  async unsubscribe(userId: string, skillKey: string): Promise<{ subscription?: SubscriptionDocument; error?: string }> {
    const subscription = await subscriptionRepository.cancel(userId, skillKey);
    if (!subscription) {
      return { error: '未找到活跃订阅' };
    }

    // 原子减少下载数
    await skillRepository.decrementDownloadCount(skillKey);

    return { subscription };
  }

  /** 批量取消订阅 */
  async batchUnsubscribe(items: { userId: string; skillKey: string }[]) {
    const results: { userId: string; skillKey: string; success: boolean; error?: string }[] = [];

    for (const { userId, skillKey } of items) {
      const subscription = await subscriptionRepository.cancel(userId, skillKey);
      if (subscription) {
        await skillRepository.decrementDownloadCount(skillKey);
        results.push({ userId, skillKey, success: true });
      } else {
        results.push({ userId, skillKey, success: false, error: '未找到活跃订阅' });
      }
    }

    return {
      results,
      total: items.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    };
  }

  /** 级联取消某 Skill 的所有订阅 */
  async cancelAllForSkill(skillKey: string): Promise<void> {
    await subscriptionRepository.cancelAllForSkill(skillKey);
  }
}

export const subscriptionService = new SubscriptionService();
