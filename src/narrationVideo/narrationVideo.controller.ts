import type { Request, Response } from 'express';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { narrationVideoService } from './narrationVideo.service.ts';
import type { NarrationVideo } from '../../type/index.d.ts';

/**
 * 解析本次请求的目标用户 id：显式传入（query.userId 优先，其次 body.userId）> JWT 登录身份。
 * 各处接口共用同一口径（与 videoPipelineV2.controller 一致）。
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

/**
 * POST /api/narrationVideo/tasks — 提交解说视频任务
 * （body：sceneTaskId/voiceId/narration 必填；speedMode 可选，缺省 balanced；userId 可选，回退 JWT）
 *
 * narration 为前端提交的解说结构化数据 `{ title, summary, segments: [{ start, end, text, emotion, clips }] }`
 * （start/end 为源视频时间轴毫秒）。服务端从 sceneTaskId 解析源视频，归一化校验后只建 pending 任务并
 * 返回 taskId，由 leader dispatcher 异步执行；客户端轮询 GET /tasks/:taskId 取进度与最终视频地址。
 */
export const submitTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const body = raw as Record<string, string | undefined>;
    const userId = resolveUserId(req) ?? '';

    const dto: NarrationVideo.SubmitTaskDto = {
      sceneTaskId: body.sceneTaskId ?? '',
      voiceId: body.voiceId ?? '',
      ...(body.speedMode ? { speedMode: body.speedMode } : {}),
      narration: (raw.narration ?? { segments: [] }) as NarrationVideo.NarrationInput,
      ...(userId ? { userId } : {}),
    };

    const result = await narrationVideoService.submit(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '解说视频任务已提交');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '解说视频任务提交失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/narrationVideo/tasks — 分页查询解说视频任务
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
    const query: NarrationVideo.TaskQuery = {
      ...(typeof status === 'string' && status.trim()
        ? { status: status.trim() as NarrationVideo.TaskStatus }
        : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await narrationVideoService.listTasks(userId, query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询解说视频任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询解说视频任务失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/narrationVideo/tasks/:taskId — 查询任务详情与进度
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

    const result = await narrationVideoService.getTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询解说视频任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询解说视频任务失败', HttpStatus.ERROR);
  }
};

/**
 * POST /api/narrationVideo/tasks/:taskId/cancel — 取消排队中的解说视频任务
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

    const result = await narrationVideoService.cancel(taskId, userId);
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
 * GET /api/narrationVideo/tasks/:taskId/queue — 查询任务排队位置
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

    const result = await narrationVideoService.getQueuePosition(taskId, userId);
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
 * GET /api/narrationVideo/tasks/queue/status — 解说视频任务队列计数
 * （全局口径，无需归属鉴权：总数 / 等待中 / 运行中，跨 worker 一致）
 */
export const getTaskQueueStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await narrationVideoService.getQueueStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询解说视频任务队列计数成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询解说视频任务队列计数失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/narrationVideo/engine/status — 解说视频引擎状态。
 * 只报配音通道开关、队列深度与本调度器状态；GPU 指标请调用 GET /api/system/resources。
 */
export const getEngineStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await narrationVideoService.getEngineStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询引擎状态成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询引擎状态失败', HttpStatus.ERROR);
  }
};
