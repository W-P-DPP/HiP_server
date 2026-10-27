import { Router } from 'express';
import { getModels } from './model.controller.ts';

/** AI 模型路由 */
const router = Router();

/** GET /hip/api/cmdc/models — cmdc 平台支持的模型列表 */
router.get('/', getModels);

export default router;
