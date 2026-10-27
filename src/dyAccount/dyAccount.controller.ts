import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { dyAccountService } from './dyAccount.service.ts';
import type { CreateDyAccountDto, UpdateDyAccountDto, DyAccountQueryDto } from './dyAccount.dto.ts';
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

/** GET /api/dyAccounts — 抖音应用配置分页列表 */
export const listDyAccounts = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { status, keyword, page, limit } = req.query;
    const query: DyAccountQueryDto = {
      userId,
      ...(status && typeof status === 'string' ? { status: status as DyAccountQueryDto['status'] } : {}),
      ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await dyAccountService.list(userId, query);
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/dyAccounts/mine — 获取当前登录用户的抖音应用配置 */
export const getMyDyAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const result = await dyAccountService.getMine(userId);
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

/** GET /api/dyAccounts/:id — 获取单个抖音应用配置 */
export const getDyAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await dyAccountService.getById(userId, id);
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

/** POST /api/dyAccounts — 创建抖音应用配置 */
export const createDyAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const dto = req.body as CreateDyAccountDto;
    if (!dto.name || !dto.clientKey || !dto.clientSecret) {
      res.sendFail('name、clientKey、clientSecret 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await dyAccountService.create(userId, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.CONFLICT);
      return;
    }
    res.sendSuccess(result.created, '抖音应用配置创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /api/dyAccounts/:id — 更新抖音应用配置（部分更新） */
export const updateDyAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto = req.body as UpdateDyAccountDto;
    const hasField =
      dto.status !== undefined ||
      Boolean(dto.name || dto.clientKey || dto.clientSecret);
    if (!hasField) {
      res.sendFail('无更新字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await dyAccountService.update(userId, id, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.updated, '抖音应用配置更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/dyAccounts/:id — 删除抖音应用配置（假删除） */
export const deleteDyAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await dyAccountService.delete(userId, id);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(null, '抖音应用配置已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
