import { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { taskRunService } from './taskRun.service.ts';
import type { CreateTaskRunDto, UpdateTaskRunDto, TaskRunQueryDto } from './taskRun.dto.ts';
import type { TaskRunStatus } from './taskRun.entity.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** GET /api/taskRuns */
export const listTaskRuns = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, taskId, status, keyword, page, limit } = req.query;

    const query: TaskRunQueryDto = {
      ...(userId && typeof userId === 'string' ? { userId } : {}),
      ...(taskId && typeof taskId === 'string' ? { taskId } : {}),
      ...(status && typeof status === 'string' ? { status: status as TaskRunStatus } : {}),
      ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await taskRunService.list(query);
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/taskRuns/:id */
export const getTaskRunById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const taskRun = await taskRunService.getById(id);
    if (!taskRun) {
      res.sendFail('运行记录不存在', HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(taskRun);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /api/taskRuns */
export const createTaskRun = async (req: Request, res: Response): Promise<void> => {
  try {
    const dto = req.body as CreateTaskRunDto;

    if (!dto.taskId || !dto.userId || !dto.status) {
      res.sendFail('taskId、userId、status 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await taskRunService.create(dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.CONFLICT);
      return;
    }
    res.sendSuccess(result.created, '运行记录创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /api/taskRuns/:id */
export const updateTaskRun = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const dto = req.body as UpdateTaskRunDto;

    const result = await taskRunService.update(id, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.updated, '运行记录更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/taskRuns/:id */
export const deleteTaskRun = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const result = await taskRunService.delete(id);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(null, '运行记录已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
