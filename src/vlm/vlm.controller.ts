import type { Request, Response } from 'express';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { vlmService } from './vlm.service.ts';
import type { Vlm } from '../../type/index.d.ts';

/**
 * 解析本次请求的目标用户 id：显式传入（query.userId 优先，其次 body.userId）> JWT 登录身份。
 *
 * 显式传参便于服务端/脚本不带 JWT 用户身份时按 userId 直连；各处接口共用同一口径。
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

/** 取 body 里的可选字符串字段（multipart 下也可能来自 query） */
function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value ? value : undefined;
}

/**
 * 组装提交入参。`mode` / `prompt` 的合法性由 service 归一 —— 传了非法 mode 不该让整次提交
 * 失败，回落到 json 即可（与容器侧 `normalize_mode` 同策略）。
 */
function readSubmitDto(req: Request, userId: string | undefined): Vlm.SubmitTaskDto {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const mode = optionalString(body.mode) ?? optionalString(req.query.mode);
  const prompt = optionalString(body.prompt) ?? optionalString(req.query.prompt);

  return {
    mode: (mode ?? 'json') as Vlm.Mode,
    prompt: prompt ?? '',
    ...(userId ? { userId } : {}),
  };
}

/**
 * POST /api/vlm/tasks — 提交图片理解任务
 * （multipart：file 图片；或 JSON/表单：fileId 引用已有文件。二者取其一；mode/prompt 可选）
 *
 * 只建 pending 任务并返回 taskId，由 leader dispatcher 异步提交给独立的 Qwen3-VL 容器执行；
 * 客户端轮询 GET /tasks/:taskId 取进度与结果。
 */
export const submitTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const dto = readSubmitDto(req, userId);

    // multipart 的 file 优先；没有文件时走 fileId 口径
    if (req.file) {
      const result = await vlmService.submitFromFile(req.file, dto);
      if ('error' in result) {
        res.sendFail(result.error, result.code);
        return;
      }
      res.sendSuccess(result.data, '图片理解任务已提交');
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const fileId = optionalString(body.fileId);
    if (!fileId) {
      res.sendFail('file（图片文件）与 fileId 必须提供其一', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await vlmService.submitFromFileId(fileId, dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '图片理解任务已提交');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '图片理解任务提交失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/vlm/tasks — 分页查询理解任务
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
    const query: Vlm.TaskQuery = {
      ...(typeof status === 'string' && status.trim()
        ? { status: status.trim() as Vlm.TaskStatus }
        : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await vlmService.listTasks(userId, query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询图片理解任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询图片理解任务失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/vlm/tasks/:taskId — 查询任务详情与进度
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

    const result = await vlmService.getTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询图片理解任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询图片理解任务失败', HttpStatus.ERROR);
  }
};

/**
 * POST /api/vlm/tasks/:taskId/cancel — 取消排队中的图片理解任务
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

    const result = await vlmService.cancel(taskId, userId);
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
 * GET /api/vlm/tasks/:taskId/queue — 查询任务排队位置
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

    const result = await vlmService.getQueuePosition(taskId, userId);
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
 * GET /api/vlm/tasks/queue/status — 图片理解任务队列计数
 * （全局口径，无需归属鉴权：总数 / 等待中 / 运行中，跨 worker 一致）
 */
export const getTaskQueueStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await vlmService.getQueueStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询图片理解任务队列计数成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询图片理解任务队列计数失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/vlm/engine/status — 引擎状态。
 *
 * `reachable` 是「容器侧模型在位」而非「服务可用」：容器懒加载 + 空闲卸载，未用过或已卸载时
 * 它就是 false，而第一个任务会自动把它拉起来。想确认容器活着，看它自己的 `/healthz` 或容器日志。
 */
export const getEngineStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await vlmService.getEngineStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询引擎状态成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询引擎状态失败', HttpStatus.ERROR);
  }
};
