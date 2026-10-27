import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { wxAccountService } from './wxAccount.service.ts';
import type { CreateWxAccountDto, UpdateWxAccountDto, WxAccountQueryDto } from './wxAccount.dto.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** 从 JWT 解析当前用户 id，缺失时返回 401 并返回 undefined */
function requireUserId(req: Request, res: Response): string | undefined {
  const userId = req.jwtPayload?.id as string | undefined;
  if (!userId) {
    res.sendFail('未登录或缺少用户身份', HttpStatus.UNAUTHORIZED);
    return undefined;
  }
  return userId;
}

/** GET /api/wxAccounts — 公众号配置分页列表 */
export const listWxAccounts = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { status, keyword, page, limit } = req.query;
    const query: WxAccountQueryDto = {
      userId,
      ...(status && typeof status === 'string' ? { status: status as WxAccountQueryDto['status'] } : {}),
      ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await wxAccountService.list(userId, query);
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/wxAccounts/:id — 获取单个公众号配置 */
export const getWxAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await wxAccountService.getById(userId, id);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.account);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /api/wxAccounts — 创建公众号配置 */
export const createWxAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const dto = req.body as CreateWxAccountDto;
    if (!dto.name || !dto.appId || !dto.appSecret || !dto.token || !dto.encodingAESKey) {
      res.sendFail('name、appId、appSecret、token、encodingAESKey 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await wxAccountService.create(userId, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.CONFLICT);
      return;
    }
    res.sendSuccess(result.created, '公众号配置创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /api/wxAccounts/:id — 更新公众号配置（部分更新） */
export const updateWxAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto = req.body as UpdateWxAccountDto;
    const hasField =
      dto.status !== undefined ||
      Boolean(dto.appSecret || dto.name || dto.appId || dto.token || dto.encodingAESKey);
    if (!hasField) {
      res.sendFail('无更新字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await wxAccountService.update(userId, id, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.updated, '公众号配置更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/wxAccounts/:id — 删除公众号配置（假删除） */
export const deleteWxAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await wxAccountService.delete(userId, id);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(null, '公众号配置已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
