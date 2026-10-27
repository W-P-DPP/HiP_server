import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { aiChatService } from './aiChat.service.ts';
import type { CreateConversationDto, ConversationQueryDto, MessageQueryDto, ChatRequestDto } from './aiChat.dto.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { createChatClient, streamChatCompletion } from '../../utils/AIPlatform/chatClient.ts';
import { initSse, writeSse, endSse } from '../../utils/AIPlatform/sse.ts';

/** 从 JWT 解析当前用户 id，缺失时返回 401 并返回 undefined */
function requireUserId(req: Request, res: Response): string | undefined {
  const userId = req.jwtPayload?.id as string | undefined;
  if (!userId) {
    res.sendFail('未登录或缺少用户身份', HttpStatus.UNAUTHORIZED);
    return undefined;
  }
  return userId;
}

/** GET /api/aiChat/conversations — 会话分页列表 */
export const listConversations = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { accountId, keyword, page, limit } = req.query;
    const query: ConversationQueryDto = {
      userId,
      ...(accountId && typeof accountId === 'string' ? { accountId } : {}),
      ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await aiChatService.listConversations(userId, query);
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiChat/conversations/:id — 会话详情 */
export const getConversation = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiChatService.getConversation(userId, id);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.conversation);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiChat/conversations/:id/messages — 会话消息分页（升序） */
export const listMessages = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const { page, limit } = req.query;
    const query: MessageQueryDto = {
      userId,
      conversationId: id,
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await aiChatService.listMessages(userId, id, query);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.page);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /api/aiChat/conversations — 创建会话 */
export const createConversation = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const dto = req.body as CreateConversationDto;
    if (!dto.accountId) {
      res.sendFail('accountId 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiChatService.createConversation(userId, dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.created, '会话创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/aiChat/conversations/:id — 删除会话（假删除，级联消息） */
export const deleteConversation = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiChatService.deleteConversation(userId, id);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(null, '会话已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/aiChat/conversations/:id/chat — 流式对话（SSE）
 *
 * 前置校验（未登录 / id 非法 / content 缺失 / 会话或配置不可用）全部在写出 SSE 头之前完成，
 * 失败仍返回普通 ResultVO 信封；一旦开始推流，错误改以 { type:'error' } 帧下发。
 */
export const streamChat = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const { id } = req.params;
  if (!id || !Types.ObjectId.isValid(id)) {
    res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
    return;
  }

  const dto = req.body as ChatRequestDto;
  if (!dto?.content || typeof dto.content !== 'string' || !dto.content.trim()) {
    res.sendFail('content 为必填字段', HttpStatus.BAD_REQUEST);
    return;
  }

  let prepared;
  try {
    const result = await aiChatService.prepareChat(userId, id, dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    prepared = result.prepared;
  } catch (err) {
    const message = err instanceof Error ? err.message : '对话准备失败';
    res.sendFail(message, HttpStatus.ERROR);
    return;
  }

  // 客户端提前断开时中止上游请求；仅在响应未正常结束时才算断开
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  initSse(res);
  writeSse(res, { type: 'start', conversationId: prepared.conversationId, model: prepared.model });

  const client = createChatClient(prepared.credential);
  let answer = '';

  try {
    for await (const chunk of streamChatCompletion(client, {
      model: prepared.model,
      messages: prepared.messages,
      signal: abort.signal,
    })) {
      if (chunk.finish) break;
      answer += chunk.content;
      writeSse(res, { type: 'delta', content: chunk.content });
    }

    const saved = await aiChatService.appendAssistantMessage(userId, prepared.conversationId, {
      content: answer,
      model: prepared.model,
      status: 'success',
    });
    writeSse(res, { type: 'done', messageId: String(saved._id), content: answer });
  } catch (err) {
    const message = err instanceof Error ? err.message : '对话失败';
    // 失败也落库（保留已生成片段），落库本身出错不应掩盖原始错误
    try {
      await aiChatService.appendAssistantMessage(userId, prepared.conversationId, {
        content: answer,
        model: prepared.model,
        status: 'failed',
        error: message,
      });
    } catch {
      // ignore
    }
    writeSse(res, { type: 'error', message });
  } finally {
    endSse(res);
  }
};
