import { Router } from 'express';
import {
  getUserSubscriptions,
  checkSubscription,
  subscribe,
  batchUnsubscribe,
  unsubscribe,
} from './subscription.controller.ts';

/**
 * 订阅路由
 *
 * 权限：公开路由（本服务为内部可信服务，上游已验证用户身份，JWT_ENABLED=false）
 */
const router = Router();

// 注意：/ 必须在 /:userId/:skillKey 之前注册，否则 Express 会把空路径匹配到 :userId
router.get('/', getUserSubscriptions);
router.get('/:userId/:skillKey', checkSubscription);
router.post('/', subscribe);
router.delete('/batch', batchUnsubscribe);
router.delete('/:userId/:skillKey', unsubscribe);

export default router;
