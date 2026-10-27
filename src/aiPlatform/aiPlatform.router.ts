import { Router } from 'express';
import {
  listProviders,
  listAIPlatforms,
  getAIPlatform,
  createAIPlatform,
  updateAIPlatform,
  deleteAIPlatform,
} from './aiPlatform.controller.ts';

/**
 * AI 平台配置路由
 *
 * 权限：需登录（JWT），操作恒按当前用户隔离（req.jwtPayload.id）
 */
const router = Router();

router.get('/', listAIPlatforms);
// 注意：/providers 必须注册在 /:id 之前，否则会被当作 id 匹配
router.get('/providers', listProviders);
router.get('/:id', getAIPlatform);
router.post('/', createAIPlatform);
router.put('/:id', updateAIPlatform);
router.delete('/:id', deleteAIPlatform);

export default router;
