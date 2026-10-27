import { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { scheduledTaskService } from './scheduledTask.service.ts';
import type { CreateScheduledTaskDto, UpdateScheduledTaskDto, ScheduledTaskQueryDto, RunRecordQueryDto } from './scheduledTask.dto.ts';
import type { ScheduledTaskStatus } from './scheduledTask.entity.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** GET /api/scheduledTasks */
export const listScheduledTasks = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, status, keyword, page, limit } = req.query;

    const query: ScheduledTaskQueryDto = {
      ...(userId && typeof userId === 'string' ? { userId } : {}),
      ...(status && typeof status === 'string' ? { status: status as ScheduledTaskStatus } : {}),
      ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await scheduledTaskService.list(query);
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/scheduledTasks/runs?userId=xxx */
export const listRunRecords = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, page, limit } = req.query;

    if (!userId || typeof userId !== 'string') {
      res.sendFail('userId 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const query: RunRecordQueryDto = {
      userId,
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await scheduledTaskService.listRunRecords(query);
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/scheduledTasks/:id */
export const getScheduledTaskById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const scheduledTask = await scheduledTaskService.getById(id);
    if (!scheduledTask) {
      res.sendFail('定时任务不存在', HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(scheduledTask);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /api/scheduledTasks */
export const createScheduledTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const dto = req.body as CreateScheduledTaskDto;

    if (!dto.title || !dto.cron || !dto.userId || !dto.description) {
      res.sendFail('任务名称、任务时间、任务描述、 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await scheduledTaskService.create(dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.CONFLICT);
      return;
    }
    res.sendSuccess(result.created, '定时任务创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /api/scheduledTasks/:id */
export const updateScheduledTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const dto = req.body as UpdateScheduledTaskDto;

    const result = await scheduledTaskService.update(id, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.updated, '定时任务更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/scheduledTasks/batch  { ids: string[] } */
export const batchDeleteScheduledTasks = async (req: Request, res: Response): Promise<void> => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      res.sendFail('ids 为非空数组', HttpStatus.BAD_REQUEST);
      return;
    }
    if (ids.some((id: unknown) => typeof id !== 'string' || !Types.ObjectId.isValid(id))) {
      res.sendFail('ids 中包含非法 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await scheduledTaskService.batchDelete(ids);
    res.sendSuccess(result, `成功删除 ${result.deletedCount} 个定时任务`);
  } catch (err) {
    const message = err instanceof Error ? err.message : '批量删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/scheduledTasks/:id */
export const deleteScheduledTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const result = await scheduledTaskService.delete(id);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(null, '定时任务已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
