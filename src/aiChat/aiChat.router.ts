import { Router } from 'express';
import {
  listConversations,
  getConversation,
  listMessages,
  createConversation,
  deleteConversation,
  streamChat,
} from './aiChat.controller.ts';

/**
 * AI 对话路由
 *
 * 权限：需登录（JWT），会话恒按当前用户隔离（req.jwtPayload.id）
 */
const router = Router();

router.get('/conversations', listConversations);
router.post('/conversations', createConversation);
// 注意：/conversations/:id/messages 必须注册在 /conversations/:id 之前
router.get('/conversations/:id/messages', listMessages);
router.get('/conversations/:id', getConversation);
// SSE 流式对话
router.post('/conversations/:id/chat', streamChat);
router.delete('/conversations/:id', deleteConversation);

export default router;
