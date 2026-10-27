import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { sessionService } from './session.service.ts';
import type { CreateSessionDto, UpdateSessionDto, SessionQueryDto } from './session.dto.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** GET /hip/api/sessions */
export const listSessions = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, status, scene, name, keyword, includeExpired, page, limit } = req.query;

    const query: SessionQueryDto = {
      ...(userId && typeof userId === 'string' ? { userId } : {}),
      ...(status && typeof status === 'string' ? { status: status as SessionQueryDto['status'] } : {}),
      ...(scene && typeof scene === 'string' ? { scene } : {}),
      ...(name && typeof name === 'string' ? { name } : {}),
      ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
      // 管理视角默认包含已过期，可通过 includeExpired=false 排除
      includeExpired: includeExpired === undefined ? true : includeExpired === 'true',
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await sessionService.list(query);
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /hip/api/sessions/:id */
export const getSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('缺少有效的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const session = await sessionService.getById(id);
    if (!session) {
      res.sendFail('Session 不存在', HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /hip/api/sessions */
export const createSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const dto = req.body as CreateSessionDto;

    // 校验 userId、scene、name 必填
    if (!dto.userId?.trim() ||  !dto.name?.trim()) {
      res.sendFail('userId、name 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await sessionService.create(dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.CONFLICT);
      return;
    }
    res.sendSuccess(result.created, 'Session 创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /hip/api/sessions/:id */
export const updateSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('缺少有效的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const dto = req.body as UpdateSessionDto;

    // name / scene 若传则必须非空
    if (dto.name !== undefined && (typeof dto.name !== 'string' || dto.name.trim().length === 0)) {
      res.sendFail('name 不能为空', HttpStatus.BAD_REQUEST);
      return;
    }
    // if (dto.scene !== undefined && (typeof dto.scene !== 'string' || dto.scene.trim().length === 0)) {
    //   res.sendFail('scene 不能为空', HttpStatus.BAD_REQUEST);
    //   return;
    // }

    const result = await sessionService.update(id, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.updated, 'Session 更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /hip/api/sessions/:id */
export const deleteSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('缺少有效的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const result = await sessionService.delete(id);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(null, 'Session 已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
