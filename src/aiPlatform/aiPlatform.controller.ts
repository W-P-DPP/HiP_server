import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { aiPlatformService } from './aiPlatform.service.ts';
import type { CreateAIPlatformDto, UpdateAIPlatformDto, AIPlatformQueryDto } from './aiPlatform.dto.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { isAIProvider } from '../../utils/AIPlatform/provider.ts';

/** 从 JWT 解析当前用户 id，缺失时返回 401 并返回 undefined */
function requireUserId(req: Request, res: Response): string | undefined {
  const userId = req.jwtPayload?.id as string | undefined;
  if (!userId) {
    res.sendFail('未登录或缺少用户身份', HttpStatus.UNAUTHORIZED);
    return undefined;
  }
  return userId;
}

/** GET /api/aiPlatforms/providers — 支持的 AI 平台目录（含预设模型） */
export const listProviders = async (req: Request, res: Response): Promise<void> => {
  try {
    const list = await aiPlatformService.listProviders();
    res.sendSuccess({ list });
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiPlatforms — AI 平台配置分页列表 */
export const listAIPlatforms = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { provider, status, keyword, page, limit } = req.query;
    const query: AIPlatformQueryDto = {
      userId,
      ...(isAIProvider(provider) ? { provider } : {}),
      ...(status && typeof status === 'string' ? { status: status as AIPlatformQueryDto['status'] } : {}),
      ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await aiPlatformService.list(userId, query);
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiPlatforms/:id — 获取单个 AI 平台配置 */
export const getAIPlatform = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiPlatformService.getById(userId, id);
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

/** POST /api/aiPlatforms — 创建 AI 平台配置 */
export const createAIPlatform = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const dto = req.body as CreateAIPlatformDto;
    if (!dto.name?.trim() || !dto.apiKey || !dto.defaultModel || !dto.provider) {
      res.sendFail('name、provider、apiKey、defaultModel 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }
    if (!isAIProvider(dto.provider)) {
      res.sendFail('不支持的 AI 平台', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiPlatformService.create(userId, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.CONFLICT);
      return;
    }
    res.sendSuccess(result.created, 'AI 平台配置创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /api/aiPlatforms/:id — 更新 AI 平台配置（部分更新） */
export const updateAIPlatform = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto = req.body as UpdateAIPlatformDto;
    const hasField =
      dto.status !== undefined ||
      Boolean(dto.name || dto.provider || dto.apiKey || dto.defaultModel || dto.baseUrl !== undefined);
    if (!hasField) {
      res.sendFail('无更新字段', HttpStatus.BAD_REQUEST);
      return;
    }
    if (dto.provider !== undefined && !isAIProvider(dto.provider)) {
      res.sendFail('不支持的 AI 平台', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiPlatformService.update(userId, id, dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.updated, 'AI 平台配置更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/aiPlatforms/:id — 删除 AI 平台配置（假删除） */
export const deleteAIPlatform = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('id 参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiPlatformService.delete(userId, id);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(null, 'AI 平台配置已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
