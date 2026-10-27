import { Router } from 'express';
import {
  listDyAccounts,
  getMyDyAccount,
  getDyAccount,
  createDyAccount,
  updateDyAccount,
  deleteDyAccount,
} from './dyAccount.controller.ts';

/**
 * 抖音应用配置路由
 *
 * 权限：需登录（JWT），操作恒按当前用户隔离（req.jwtPayload.id）
 */
const router = Router();

router.get('/', listDyAccounts);
// 注意：/mine 必须注册在 /:id 之前，否则会被当作 id 匹配
router.get('/mine', getMyDyAccount);
router.get('/:id', getDyAccount);
router.post('/', createDyAccount);
router.put('/:id', updateDyAccount);
router.delete('/:id', deleteDyAccount);

export default router;
