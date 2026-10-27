import type { Request, Response } from 'express';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { isSupportedAudioMime, SUBTITLE_SOURCE_CATEGORY } from '../../utils/constant/subtitle.ts';
import asrConfig from '../../utils/asr/asr.config.ts';
import { fileService } from '../file/file.service.ts';
import { subtitleTaskService } from './subtitleTask.service.ts';
import type { Subtitle } from '../../type/index.d.ts';

/**
 * 解析本次请求的目标用户 id：显式传入（query.userId 优先，其次 body.userId）> JWT 登录身份。
 *
 * 显式传参便于服务端/脚本不带 JWT 用户身份时按 userId 直连；三处接口共用同一口径。
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
 * POST /api/subtitles/tasks — 提交字幕生成任务
 * （multipart：file 音频文件；或 JSON：fileId 引用已有文件。二者取其一；language/userId 可选）
 *
 * 音频被登记到 file 模块（分类 subtitleSource）后建 pending 任务并立即返回 taskId，
 * 由 leader dispatcher 异步执行「ASR 转写 → 落 SRT」，客户端轮询 GET /tasks/:taskId。
 */
export const submitSubtitleTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const file = req.file;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const bodyFileId = (body.fileId ?? '').trim();

    if (file && bodyFileId) {
      res.sendFail('不能同时上传音频文件和传入 fileId，请二选一', HttpStatus.BAD_REQUEST);
      return;
    }
    if (!file && !bodyFileId) {
      res.sendFail('请上传音频文件（file）或传入 fileId', HttpStatus.BAD_REQUEST);
      return;
    }

    const userId = resolveUserId(req) ?? '';

    // 上传路径先做大小/类型预检，避免为非法输入白建一条 file 记录
    if (file) {
      if (file.size > asrConfig.maxAudioBytes) {
        const maxMb = Math.round(asrConfig.maxAudioBytes / (1024 * 1024));
        res.sendFail(`音频大小不能超过 ${maxMb}MB`, HttpStatus.BAD_REQUEST);
        return;
      }
      if (!isSupportedAudioMime(file.mimetype)) {
        res.sendFail(`不支持的音频类型：${file.mimetype || '未知'}`, HttpStatus.BAD_REQUEST);
        return;
      }
    }

    let fileId: string;
    let sourceType: Subtitle.SourceType;
    if (file) {
      const uploaded = await fileService.upload(file, {
        category: SUBTITLE_SOURCE_CATEGORY,
        ...(userId ? { createBy: userId } : {}),
      });
      fileId = String(uploaded.created._id);
      sourceType = 'upload';
    } else {
      fileId = bodyFileId;
      sourceType = 'fileId';
    }

    const dto: Subtitle.SubmitTaskDto = {
      fileId,
      sourceType,
      ...(body.language ? { language: body.language } : {}),
      ...(userId ? { userId } : {}),
    };

    const result = await subtitleTaskService.submit(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '字幕任务已提交');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '字幕任务提交失败', HttpStatus.ERROR);
  }
};

/**
 * POST /api/subtitles/tasks/from-media — 提交字幕任务（当场上传音频或视频）
 * （multipart：file 音频或视频必填；language/userId 可选）
 *
 * 音频直接用；**视频先经 ffmpeg 提取音频再转写**（提取产物落临时目录，不入 file 表）。
 * 与 POST /tasks 的差别：边上边建，不需要先拿到 fileId；视频提取失败/无音轨在本次请求内直接 400。
 * 之后同样是建 pending 任务并交给 leader dispatcher 异步执行「ASR 转写 → 落 SRT」，
 * 客户端轮询 GET /tasks/:taskId。校验与清理都在 service 内完成（含 multer 落盘的临时文件）。
 */
export const submitSubtitleTaskFromMedia = async (req: Request, res: Response): Promise<void> => {
  try {
    const file = req.file;
    if (!file) {
      res.sendFail('请上传音频或视频文件（file）', HttpStatus.BAD_REQUEST);
      return;
    }

    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const userId = resolveUserId(req) ?? '';

    const result = await subtitleTaskService.submitFromMediaFile(file, {
      ...(body.language ? { language: body.language } : {}),
      ...(userId ? { userId } : {}),
    });
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '字幕任务已提交');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '字幕任务提交失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/subtitles/tasks — 分页查询字幕任务
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
    const query: Subtitle.TaskQuery = {
      ...(typeof status === 'string' && status.trim() ? { status: status.trim() as Subtitle.TaskStatus } : {}),
      ...(page ? { page: parseInt(page as string, 10) } : {}),
      ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await subtitleTaskService.listTasks(userId, query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询字幕任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询字幕任务失败', HttpStatus.ERROR);
  }
};

/**
 * GET /api/subtitles/tasks/:taskId — 查询任务详情与进度
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

    const result = await subtitleTaskService.getTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询字幕任务成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询字幕任务失败', HttpStatus.ERROR);
  }
};

/**
 * POST /api/subtitles/tasks/:taskId/cancel — 取消排队中的字幕任务
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

    const result = await subtitleTaskService.cancel(taskId, userId);
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
 * GET /api/subtitles/tasks/:taskId/queue — 查询任务排队位置
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

    const result = await subtitleTaskService.getQueuePosition(taskId, userId);
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
 * GET /api/subtitles/tasks/queue/status — 字幕任务队列计数
 * （全局口径，无需归属鉴权：总数 / 等待中 / 运行中，跨 worker 一致）
 */
export const getTaskQueueStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await subtitleTaskService.getQueueStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询字幕任务队列计数成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询字幕任务队列计数失败', HttpStatus.ERROR);
  }
};

/** GET /api/subtitles/engine/status — 字幕引擎状态（通道配置、队列深度、本地 Whisper 可达性） */
export const getEngineStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await subtitleTaskService.getEngineStatus();
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '查询引擎状态成功');
  } catch (err) {
    res.sendFail(err instanceof Error ? err.message : '查询引擎状态失败', HttpStatus.ERROR);
  }
};
