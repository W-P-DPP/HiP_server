import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { videoMaterialGroupService } from './videoMaterialGroup.service.ts';
import type { CreateVideoMaterialGroupDto, UpdateVideoMaterialGroupDto } from './videoMaterialGroup.dto.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** GET /api/videoMaterialGroups —— 当前用户的分组列表 */
export const listVideoMaterialGroups = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await videoMaterialGroupService.list();
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /api/videoMaterialGroups —— 新建分组 { name } */
export const createVideoMaterialGroup = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dto: CreateVideoMaterialGroupDto = {
      name: typeof body.name === 'string' ? body.name.trim() : '',
    };

    const result = await videoMaterialGroupService.create(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '分组创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /api/videoMaterialGroups/:id —— 重命名分组 { name } */
export const updateVideoMaterialGroup = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const dto: UpdateVideoMaterialGroupDto = {};
    if (typeof body.name === 'string') {
      dto.name = body.name;
    }

    const result = await videoMaterialGroupService.update(id, dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '分组更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/videoMaterialGroups/:id —— 删除分组（其下素材转未分组） */
export const deleteVideoMaterialGroup = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await videoMaterialGroupService.delete(id);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(null, '分组已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
