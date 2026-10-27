import { Router } from 'express';
import { getMailerStatus, sendMail } from './mailer.controller.ts';

/**
 * 邮件服务路由
 *
 * 权限：免 JWT（/mailer 在 unJwtConstants 白名单内，由 /hip/api 挂载点的 jwtMiddleware 放行）
 */
const router = Router();

/** POST /api/mailer/send — 发送邮件 */
router.post('/send', sendMail);
/** GET /api/mailer/status — 邮件服务状态 */
router.get('/status', getMailerStatus);

export default router;
