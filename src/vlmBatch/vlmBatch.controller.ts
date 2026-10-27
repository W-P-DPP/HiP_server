import type { Request, Response } from 'express';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { vlmBatchService } from './vlmBatch.service.ts';
import type { VlmBatch } from '../../type/index.d.ts';

/**
 * 解析本次请求的目标用户 id：显式传入（query.userId 优先，其次 body.userId）> JWT 登录身份。
 *
 * 与 `vlm.controller.ts` 同一口径，便于服务端/脚本不带 JWT 用户身份时按 userId 直连。
 */
function resolveUserId(req: Request): string | undefined {
  const { userId } = req.query;
  if (typeof userId === 'string' && userId.trim()) return userId.trim();

  const body = req.body as Record<string, unknown> | undefined;
  const bodyUserId = body?.userId;
  if (typeof bodyUserId === 'string' && bodyUserId.trim()) return bodyUserId.trim();

  const jwtUserId = req.jwtPayload?.id as string | undefined;
  return jwtUserId && jwtUserId.trim() ? jwtUserId : undefined;
}

/** 取 body 里的可选字符串字段（也允许从 query 取，便于 GET/表单场景） */
function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value ? value : undefined;
}

/** 组装提交入参。`mode`/`prompt` 的合法性由 service 归一 —— 非法 mode 回落 json，不该让提交失败 */
function readSubmitDto(req: Request, userId: string | undefined): VlmBatch.SubmitTaskDto {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const mode = optionalString(body.mode) ?? optionalString(req.query.mode);
  const prompt = optionalString(body.prompt) ?? optionalString(req.query.prompt);

  return {
    mode: (mode ?? 'json') as VlmBatch.SubmitTaskDto['mode'],
    prompt: prompt ?? '',
    ...(userId ? { userId } : {}),
  };
}

/**
 * POST /api/vlmBatch/tasks — 提交批量图像识别任务
 * （body：taskId 已完成抽帧任务 id，必填；mode/prompt 可选，整批共用）
 *
 * 只建 pending 任务并返回 taskId，由 leader dispatcher 异步逐张提交给独立的 Qwen3-VL 容器执行；
 * 客户端轮询 GET /tasks/:taskId 取整批进度与逐项结果。
 */
export const submitTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const dto = readSubmitDto(req, userId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskId = optionalString(body.taskId) ?? optionalString(req.query.taskId);
    if (!taskId) {
      res.sendFail('taskId（已完成的抽帧任务 id）为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await vlmBatchService.submitFromFramesTask(taskId, dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '批量图像识别任务已提交');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '批量图像识别任务提交失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/vlmBatch/tasks — 分页查询批量识别任务
 * （query：userId 精确可选，缺省回退当前登录用户；status 可选；page/limit）
 */
export const listTasks = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { status, page, limit } = req.query;
    const query: VlmBatch.TaskQuery = {
      ...(typeof status === 'string' && status.trim()
        ? { status: status.trim() as VlmBatch.TaskStatus }
        : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await vlmBatchService.listTasks(userId, query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询批量图像识别任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询批量图像识别任务失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/vlmBatch/tasks/:taskId — 查询任务详情（含逐项结果）
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 */
export const getTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('非法的 taskId 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const result = await vlmBatchService.getTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询批量图像识别任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询批量图像识别任务失败', HttpStatus.ERROR);
  }
};

/**
 * POST /api/vlmBatch/tasks/:taskId/cancel — 取消排队中的批量识别任务
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 *
 * 仅 status=pending 的任务可取消；已被调度器领取执行或已进入终态的一律拒绝。
 */
export const cancelTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('非法的 taskId 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const result = await vlmBatchService.cancel(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '任务已取消');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '取消任务失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/vlmBatch/tasks/:taskId/queue — 查询任务排队位置
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 */
export const getTaskQueuePosition = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('非法的 taskId 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const result = await vlmBatchService.getQueuePosition(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询排队位置成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询排队位置失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/vlmBatch/tasks/queue/status — 批量识别任务队列计数
 * （全局口径，无需归属鉴权：总数 / 等待中 / 运行中，跨 worker 一致）
 */
export const getTaskQueueStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await vlmBatchService.getQueueStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询批量图像识别任务队列计数成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询批量图像识别任务队列计数失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/vlmBatch/engine/status — 引擎状态。
 *
 * `reachable` 是「容器侧模型在位」而非「服务可用」：容器懒加载 + 空闲卸载，未用过或已卸载时
 * 它就是 false，而第一个任务会自动把它拉起来。想确认容器活着，看它自己的 `/healthz` 或容器日志。
 */
export const getEngineStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await vlmBatchService.getEngineStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询引擎状态成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询引擎状态失败', HttpStatus.ERROR);
  }
};
