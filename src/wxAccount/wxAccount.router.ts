import { Router } from 'express';
import {
  listWxAccounts,
  getWxAccount,
  createWxAccount,
  updateWxAccount,
  deleteWxAccount,
} from './wxAccount.controller.ts';

/**
 * 微信公众号配置路由
 *
 * 权限：需登录（JWT），操作恒按当前用户隔离（req.jwtPayload.id）
 */
const router = Router();

router.get('/', listWxAccounts);
router.get('/:id', getWxAccount);
router.post('/', createWxAccount);
router.put('/:id', updateWxAccount);
router.delete('/:id', deleteWxAccount);

export default router;
