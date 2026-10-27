import { Router } from 'express';
import { listSessions, getSession, createSession, updateSession, deleteSession } from './session.controller.ts';

/**
 * Session 路由（UUID 签发登记管理）
 *
 * 权限：走 /hip/api 下统一 jwtMiddleware
 */
const router = Router();

// ---- 查询 ----
router.get('/', listSessions);
router.get('/:id', getSession);

// ---- 管理 ----
router.post('/', createSession);
router.put('/:id', updateSession);
router.delete('/:id', deleteSession);

export default router;
