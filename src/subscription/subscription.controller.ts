import type { Request, Response } from 'express';
import { subscriptionService } from './subscription.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** GET /api/subscriptions?userId=xxx&status=active */
export const getUserSubscriptions = async (req: Request, res: Response): Promise<void> => {
  const { userId, status } = req.query;
  if (!userId || typeof userId !== 'string') {
    res.sendFail('userId 为必填参数', HttpStatus.BAD_REQUEST);
    return;
  }

  const result = await subscriptionService.getByUser(userId, status as string | undefined);
  res.sendSuccess(result);
};

/** GET /api/subscriptions/:userId/:skillKey */
export const checkSubscription = async (req: Request, res: Response): Promise<void> => {
  const { userId, skillKey } = req.params;
  const result = await subscriptionService.check(userId!, skillKey!);
  res.sendSuccess(result);
};

/** POST /api/subscriptions  { userId, skillKey } */
export const subscribe = async (req: Request, res: Response): Promise<void> => {
  const { userId, skillKey } = req.body;

  if (!userId || !skillKey) {
    res.sendFail('userId、skillKey 为必填字段', HttpStatus.BAD_REQUEST);
    return;
  }

  const result = await subscriptionService.subscribe(userId, skillKey);
  if ('error' in result) {
    res.sendFail(result.error!, HttpStatus.CONFLICT);
    return;
  }
  res.sendSuccess(result.subscription, result.renewed ? '订阅已刷新' : '订阅成功');
};

/** DELETE /api/subscriptions/batch  { items: [{ userId, skillKey }] } */
export const batchUnsubscribe = async (req: Request, res: Response): Promise<void> => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    res.sendFail('items 为非空数组', HttpStatus.BAD_REQUEST);
    return;
  }

  for (const item of items) {
    if (!item.userId || !item.skillKey) {
      res.sendFail('每个 item 需包含 userId 和 skillKey', HttpStatus.BAD_REQUEST);
      return;
    }
  }

  const result = await subscriptionService.batchUnsubscribe(items);
  res.sendSuccess(result, `成功 ${result.succeeded} 个，失败 ${result.failed} 个`);
};

/** DELETE /api/subscriptions/:userId/:skillKey */
export const unsubscribe = async (req: Request, res: Response): Promise<void> => {
  const { userId, skillKey } = req.params;
  const result = await subscriptionService.unsubscribe(userId!, skillKey!);
  if ('error' in result) {
    res.sendFail(result.error!, HttpStatus.NOT_FOUND);
    return;
  }
  res.sendSuccess(result.subscription, '已取消订阅');
};
