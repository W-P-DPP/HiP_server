import { Router } from 'express';
import { getSystemResources ,getVersion,getCloudVersion} from './system.controller.ts';

const router = Router();

// JWT 鉴权由 /hip/api/resources 挂载点的 jwtMiddleware 统一处理（app.ts），此处无需再配置
router.get('/resources', getSystemResources);
router.get('/version', getVersion);
router.get('/cloudVersion', getCloudVersion);

export default router;
