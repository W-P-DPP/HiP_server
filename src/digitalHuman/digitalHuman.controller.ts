import { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { digitalHumanAvatarService } from './digitalHumanAvatar.service.ts';
import { digitalHumanTaskService } from './digitalHumanTask.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import type { DigitalHuman } from '../../type/index.d.ts';

/**
 * 解析本次请求的目标用户 id：显式传入（query.userId 优先，其次 body.userId）> JWT 登录身份。
 *
 * 显式传参允许以指定 userId 查询/提交（与形象库 listAvatars 同口径），便于服务端/脚本
 * 不带 JWT 用户身份时按 userId 直连。三处接口共用同一口径，避免各写一套回退逻辑。
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

/** 解析布尔开关：兼容 JSON 的 true/false 与表单常见的 'true'/'1' 字符串 */
function parseBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1';
  }
  return false;
}

/** 解析烧录样式：接受对象或 JSON 字符串；非法输入返回 undefined（走服务端默认样式） */
function parseSubtitleOptions(value: unknown): DigitalHuman.SubtitleBurnOptions | undefined {
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed as DigitalHuman.SubtitleBurnOptions;
}

/** JSON.parse 的容错版本：表单里传了半截 JSON 不应让整个提交 500 */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** POST /api/digitalHuman/avatars — 上传参考视频并创建形象（multipart：file/name 必填，userId 可选） */
export const createAvatar = async (req: Request, res: Response): Promise<void> => {
  try {
    const file = req.file;
    if (!file) {
      res.sendFail('请选择要上传的参考视频文件', HttpStatus.BAD_REQUEST);
      return;
    }

    const body = req.body as Record<string, string | undefined>;
    const userId = body.userId || (req.jwtPayload?.id as string | undefined) || '';

    const dto: DigitalHuman.CreateAvatarDto = {
      name: body.name ?? '',
      ...(userId ? { userId } : {}),
    };

    const result = await digitalHumanAvatarService.createAvatar(file, dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '形象创建成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '形象创建失败', HttpStatus.ERROR);
  }
};

/** GET /api/digitalHuman/avatars — 分页查询形象（query：userId 精确 + name 模糊，均可选；page/limit） */
export const listAvatars = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, name, page, limit } = req.query;

    const query: DigitalHuman.AvatarQuery = {
      ...(typeof userId === 'string' && userId.trim() ? { userId: userId.trim() } : {}),
      ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await digitalHumanAvatarService.listAvatars(query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询形象成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询形象失败', HttpStatus.ERROR);
  }
};

/** GET /api/digitalHuman/avatars/:id — 查询形象详情 */
export const getAvatar = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await digitalHumanAvatarService.getAvatar(id);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询形象成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询形象失败', HttpStatus.ERROR);
  }
};

/** PUT /api/digitalHuman/avatars/:id — 修改形象名称（body：name，仅当前用户自己的记录） */
export const renameAvatar = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const userId = req.jwtPayload?.id as string | undefined;
    if (!userId) {
      res.sendFail('未获取到当前用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const body = req.body as Record<string, string | undefined>;
    const result = await digitalHumanAvatarService.renameAvatar(id, userId, body.name ?? '');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '形象名称修改成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '形象名称修改失败', HttpStatus.ERROR);
  }
};

/** DELETE /api/digitalHuman/avatars/:id — 删除形象（假删除，仅当前用户自己的记录） */
export const deleteAvatar = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const userId = req.jwtPayload?.id as string | undefined;
    if (!userId) {
      res.sendFail('未获取到当前用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const result = await digitalHumanAvatarService.removeAvatar(id, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '删除形象成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '删除形象失败', HttpStatus.ERROR);
  }
};

// ---- 数字人合成任务 ----
// 提交只建任务，由 leader dispatcher 异步执行；客户端轮询 GET /tasks/:taskId 取进度。

/**
 * POST /api/digitalHuman/tasks — 提交数字人合成任务
 * （body：avatarId/voiceId/text 必填；speedMode 可选，缺省 balanced；burnSubtitles/subtitleOptions
 *   可选，开启字幕烧录；userId 可选，回退 JWT）
 *
 * 服务端会先用 voiceId 把 text 合成配音，再交给 HeyGem 与形象参考视频对口型。
 * burnSubtitles=true 时会先对配音音频生成字幕（只依赖配音，故在对口型之前，ASR 失败不必白等一轮
 * GPU 合成），对口型出片后把字幕烧录进成片：resultUrl 为带字幕版本、rawVideoUrl 为烧录前原片、
 * srtUrl 为字幕文件；subtitleOptions 可选，字段缺省走服务端默认样式。
 * userId 既可放在 body 也可放在 query，两者都没有时回退 JWT（再没有则记为空归属）。
 */
export const submitTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as Record<string, string | undefined>;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const userId = resolveUserId(req) ?? '';

    const burnSubtitles = parseBoolean(raw.burnSubtitles);
    const subtitleOptions = parseSubtitleOptions(raw.subtitleOptions);

    const dto: DigitalHuman.SubmitTaskDto = {
      avatarId: body.avatarId ?? '',
      voiceId: body.voiceId ?? '',
      text: body.text ?? '',
      ...(body.speedMode ? { speedMode: body.speedMode } : {}),
      ...(burnSubtitles ? { burnSubtitles } : {}),
      ...(subtitleOptions ? { subtitleOptions } : {}),
      ...(userId ? { userId } : {}),
    };

    const result = await digitalHumanTaskService.submit(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '数字人任务已提交');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '数字人任务提交失败', HttpStatus.ERROR);
  }
};

/**
 * POST /api/digitalHuman/tasks/with-subtitle — 提交数字人合成任务（复用已有字幕任务）
 * （body：text/avatarId/voiceId/subtitleId 必填；subtitleOptions 可选样式；userId 可选，回退 JWT）
 *
 * 与 /tasks 的差异：字幕不再对本次配音跑 ASR，而是复用 subtitleId 指定的字幕任务
 * （其已生成的 SRT 会被直接烧录）；配音仍由服务端用 voiceId + text 合成。
 * 同样只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行，客户端轮询 /tasks/:taskId。
 */
export const submitWithSubtitleTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as Record<string, string | undefined>;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const userId = resolveUserId(req) ?? '';

    const subtitleOptions = parseSubtitleOptions(raw.subtitleOptions);

    const dto: DigitalHuman.SubmitWithSubtitleTaskDto = {
      text: body.text ?? '',
      avatarId: body.avatarId ?? '',
      voiceId: body.voiceId ?? '',
      subtitleId: body.subtitleId ?? '',
      ...(subtitleOptions ? { subtitleOptions } : {}),
      ...(userId ? { userId } : {}),
    };

    const result = await digitalHumanTaskService.submitWithSubtitle(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '数字人任务已提交');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '数字人任务提交失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/digitalHuman/tasks — 分页查询合成任务
 * （query：userId 精确可选，缺省回退当前登录用户；status 可选；page/limit）
 *
 * userId 允许显式指定以查询他人任务（与形象库 listAvatars 同口径）；
 * 两者都没有时按未授权处理，避免无过滤条件时把全部任务一次性暴露出去。
 */
export const listTasks = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { status, page, limit } = req.query;
    const query: DigitalHuman.TaskQuery = {
      ...(typeof status === 'string' && status.trim() ? { status: status.trim() as DigitalHuman.TaskStatus } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await digitalHumanTaskService.listTasks(userId, query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询数字人任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询数字人任务失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/digitalHuman/tasks/:taskId — 查询任务详情与进度
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

    const result = await digitalHumanTaskService.getTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询数字人任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询数字人任务失败', HttpStatus.ERROR);
  }
};

/**
 * POST /api/digitalHuman/tasks/:taskId/cancel — 取消排队中的数字人任务
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

    const result = await digitalHumanTaskService.cancel(taskId, userId);
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
 * GET /api/digitalHuman/tasks/:taskId/queue — 查询任务排队位置
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

    const result = await digitalHumanTaskService.getQueuePosition(taskId, userId);
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
 * GET /api/digitalHuman/tasks/queue/status — 数字人合成任务队列计数
 * （全局口径，无需归属鉴权：总数 / 等待中 / 运行中，跨 worker 一致）
 */
export const getTaskQueueStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digitalHumanTaskService.getQueueStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询数字人任务队列计数成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询数字人任务队列计数失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/digitalHuman/engine/status — 数字人引擎状态。
 * 只报引擎与挂载配置；GPU 利用率/显存请调用 GET /api/system/resources，此处不重复实现。
 */
export const getEngineStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digitalHumanTaskService.getEngineStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询引擎状态成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询引擎状态失败', HttpStatus.ERROR);
  }
};
