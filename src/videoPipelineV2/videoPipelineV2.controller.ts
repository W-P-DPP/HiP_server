import type { Request, Response } from 'express';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { videoPipelineV2Service } from './videoPipelineV2.service.ts';
import type { VideoPipelineV2 } from '../../type/index.d.ts';

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

/**
 * 规整 keywords：兼容数组或 JSON 字符串；过滤空串、单词 ≤50 字符、总量 ≤200。
 * 全部非法/为空时返回 undefined（走 cue 文本清洗兜底）。
 */
function normalizeKeywords(raw: unknown): string[] | undefined {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    .map(k => k.trim().slice(0, 50))
    .slice(0, 200);
  return cleaned.length ? cleaned : undefined;
}

/**
 * POST /api/videoPipelineV2/tasks — 提交视频生成管道 V2 任务
 * （body：voiceId/text 必填；speedMode 可选，缺省 balanced；color/keywords 可选；userId 可选，回退 JWT）
 *
 * 服务端先用 IndexTTS 把 text 合成配音（复用 voiceTrainV2 合成任务），再对配音音频跑 Whisper 生成
 * 字幕（复用 subtitle 任务），最后复用 toVideo 烧录字幕封装 mp4。只建 pending 任务并返回 taskId，
 * 由 leader dispatcher 异步执行；客户端轮询 GET /tasks/:taskId 取进度与最终视频地址。
 */
export const submitTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const body = raw as Record<string, string | undefined>;
    const userId = resolveUserId(req) ?? '';

    const keywords = normalizeKeywords(raw.keywords);

    const dto: VideoPipelineV2.SubmitTaskDto = {
      voiceId: body.voiceId ?? '',
      text: body.text ?? '',
      ...(body.speedMode ? { speedMode: body.speedMode } : {}),
      ...(body.color ? { color: body.color } : {}),
      ...(keywords ? { keywords } : {}),
      ...(userId ? { userId } : {}),
    };

    const result = await videoPipelineV2Service.submit(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '视频生成任务已提交');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '视频生成任务提交失败', HttpStatus.ERROR);
  }
};

/**
 * POST /api/videoPipelineV2/tasks/compose — 提交「纯合成」任务
 * （body：audioFileId/srtFileId 必填；keywords/color 可选；voiceId/text/speedMode 仅随任务记录；userId 可选，回退 JWT）
 *
 * 音频与字幕均已存在（分别由配音与字幕链路产出），因此跳过配音与字幕阶段，直接用
 * audioFileId + srtFileId 构建背景轨并烧录 mp4。只建 pending 任务并返回 taskId，
 * 由 leader dispatcher 异步执行；客户端轮询 GET /tasks/:taskId 取进度与最终视频地址。
 */
export const submitComposeTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const body = raw as Record<string, string | undefined>;
    const userId = resolveUserId(req) ?? '';

    const keywords = normalizeKeywords(raw.keywords);

    const dto: VideoPipelineV2.SubmitComposeTaskDto = {
      audioFileId: body.audioFileId ?? '',
      srtFileId: body.srtFileId ?? '',
      ...(body.voiceId ? { voiceId: body.voiceId } : {}),
      ...(body.text ? { text: body.text } : {}),
      ...(body.speedMode ? { speedMode: body.speedMode } : {}),
      ...(body.color ? { color: body.color } : {}),
      ...(keywords ? { keywords } : {}),
      ...(userId ? { userId } : {}),
    };

    const result = await videoPipelineV2Service.submitCompose(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '视频合成任务已提交');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '视频合成任务提交失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/videoPipelineV2/tasks — 分页查询管道任务
 * （query：userId 精确可选，缺省回退当前登录用户；status 可选；page/limit）
 */
export const listTasks = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { status, mode, page, limit } = req.query;
    const query: VideoPipelineV2.TaskQuery = {
      ...(typeof mode === 'string' && mode.trim()
        ? { mode: mode.trim() as VideoPipelineV2.TaskMode }
        : {}),
      ...(typeof status === 'string' && status.trim()
        ? { status: status.trim() as VideoPipelineV2.TaskStatus }
        : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await videoPipelineV2Service.listTasks(userId, query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询视频生成任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询视频生成任务失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/videoPipelineV2/tasks/:taskId — 查询任务详情与进度
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

    const result = await videoPipelineV2Service.getTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询视频生成任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询视频生成任务失败', HttpStatus.ERROR);
  }
};

/**
 * POST /api/videoPipelineV2/tasks/:taskId/cancel — 取消排队中的视频合成任务
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

    const result = await videoPipelineV2Service.cancel(taskId, userId);
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
 * GET /api/videoPipelineV2/tasks/:taskId/queue — 查询任务排队位置
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

    const result = await videoPipelineV2Service.getQueuePosition(taskId, userId);
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
 * GET /api/videoPipelineV2/tasks/queue/status — 视频合成任务队列计数
 * （全局口径，无需归属鉴权：总数 / 等待中 / 运行中，跨 worker 一致）
 */
export const getTaskQueueStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await videoPipelineV2Service.getQueueStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询视频合成任务队列计数成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询视频合成任务队列计数失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/videoPipelineV2/engine/status — 管道引擎状态。
 * 只报两段通道（IndexTTS 配音 / ASR 字幕）的开关与本地 Whisper 可达性；
 * GPU 利用率/显存请调用 GET /api/system/resources，此处不重复实现。
 */
export const getEngineStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await videoPipelineV2Service.getEngineStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询引擎状态成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询引擎状态失败', HttpStatus.ERROR);
  }
};
