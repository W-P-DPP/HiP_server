import type { Request, Response } from 'express';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { aiDetectService } from './aiDetect.service.ts';
import type { AiDetect, ChunkUpload } from '../../type/index.d.ts';

/**
 * 解析本次请求的目标用户 id：显式传入（query.userId 优先，其次 body.userId）> JWT 登录身份。
 *
 * 与 subtitle / digitalHuman / videoPipelineV2 各 controller 的同名函数口径一致。
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

/** 读可选字符串（非字符串/空白一律视为未传） */
const optionalString = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;

/**
 * 读可选数字。
 *
 * multipart 的字段值一律是字符串（`threshold=27`），JSON 请求才是原生类型，
 * 故这里两种都收 —— 否则同一个参数会因 Content-Type 不同而行为不一致。
 */
const optionalNumber = (raw: unknown): number | undefined => {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/**
 * 读整数（分片会话 init 用）：JSON 请求里是原生 number，字符串数字也一并收（客户端常沿用
 * multipart 的字符串习惯）。非法值返回 NaN，由 service 的 Number.isInteger 校验翻成 400。
 */
function readInteger(raw: unknown): number {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : Number.NaN;
  if (typeof raw === 'string' && raw.trim()) return Number.parseInt(raw, 10);
  return Number.NaN;
}

/** 从请求体提取检测参数（未传的字段整条不出现在结果里） */
const readDetectOptions = (body: Record<string, unknown>): AiDetect.DetectOptions => {
  const options: AiDetect.DetectOptions = {};

  const detector = optionalString(body.detector);
  if (detector) options.detector = detector;

  const threshold = optionalNumber(body.threshold);
  if (threshold !== undefined) options.threshold = threshold;

  const minSceneLenSec = optionalNumber(body.minSceneLenSec);
  if (minSceneLenSec !== undefined) options.minSceneLenSec = minSceneLenSec;

  const downscale = optionalNumber(body.downscale);
  if (downscale !== undefined) options.downscale = downscale;

  const frameSkip = optionalNumber(body.frameSkip);
  if (frameSkip !== undefined) options.frameSkip = frameSkip;

  const blackDetectSec = optionalNumber(body.blackDetectSec);
  if (blackDetectSec !== undefined) options.blackDetectSec = blackDetectSec;

  return options;
};

/**
 * POST /api/aiDetect/scene/tasks — 提交场景切分任务
 *
 * 四种入参互斥、必须恰好其一：
 * - multipart：字段 `file` 上传视频文件（落 file 表后切分；上限 maxVideoBytes，默认 2.5GB）
 * - JSON：`fileId` 引用已有 file 记录（同一上限）
 * - JSON：`uploadId` 引用已传完的分片会话（合并后上限同上；适合怕单请求中断的大文件）
 * - JSON：`url` 下载远程视频（落盘 + 登记 file 表后切分；下载上限另受 AI_DETECT_URL_MAX_BYTES 约束）
 *
 * 可选：detector / threshold / minSceneLenSec / downscale / frameSkip / userId。
 * 提交只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行，客户端轮询 GET /scene/tasks/:taskId。
 */
export const submitSceneTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const file = req.file;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bodyFileId = optionalString(body.fileId) ?? '';
    const bodyUploadId = optionalString(body.uploadId) ?? '';
    const bodyUrl = optionalString(body.url) ?? '';

    const provided = [
      Boolean(file),
      Boolean(bodyFileId),
      Boolean(bodyUploadId),
      Boolean(bodyUrl),
    ].filter(Boolean).length;
    if (provided === 0) {
      res.sendFail('请上传视频文件（file）、传入 fileId、uploadId 或 url，四选一', HttpStatus.BAD_REQUEST);
      return;
    }
    if (provided > 1) {
      res.sendFail('file / fileId / uploadId / url 只能四选一', HttpStatus.BAD_REQUEST);
      return;
    }

    const userId = resolveUserId(req) ?? '';
    const options = { ...readDetectOptions(body), ...(userId ? { userId } : {}) };

    const result = file
      ? await aiDetectService.submitFromFile(file, options)
      : bodyFileId
        ? await aiDetectService.submitFromFileId(bodyFileId, options)
        : bodyUploadId
          ? await aiDetectService.submitFromChunk(bodyUploadId, options)
          : await aiDetectService.submitFromUrl(bodyUrl, options);

    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '场景切分任务已提交');
  } catch (err) {
    const message = err instanceof Error ? err.message : '提交场景切分任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/aiDetect/scene/chunks/init — 初始化大文件分片上传会话
 * （JSON：fileName + fileSize + totalChunks + chunkSize?）
 *
 * 建一条分片上传会话，返回 uploadId 与分片口径；随后按 uploadId 逐片上传。
 * 合并后体量上限与整份上传同值（AI_DETECT_MAX_VIDEO_BYTES，默认 2.5GB），超期会话在下次 init 时
 * 被回收（AI_DETECT_CHUNK_SESSION_TTL_MS）。分片到齐后带 uploadId 调 POST /scene/tasks 合并建任务即可 ——
 * 合并成功才算「提交」，会话与已收分片到那时才删除。
 */
export const initSceneChunkUpload = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dto: ChunkUpload.InitDto = {
      fileName: typeof body.fileName === 'string' ? body.fileName.trim() : '',
      fileSize: readInteger(body.fileSize),
      totalChunks: readInteger(body.totalChunks),
      ...(body.chunkSize !== undefined ? { chunkSize: readInteger(body.chunkSize) } : {}),
    };

    const result = await aiDetectService.initChunkUpload(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '分片上传会话已创建');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建分片上传会话失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/aiDetect/scene/chunks/:uploadId/:index — 上传单个分片
 * （multipart：chunk 单片文件；index 为分片下标，从 0 开始）
 *
 * 落盘由 multer 完成（会话与下标已在路由中间件校验），这里只回报最新进度；
 * 断点续传时先 GET /scene/chunks/:uploadId 拿已收下标，只补缺失的那几片。
 */
export const uploadSceneChunk = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.sendFail('缺少分片文件（字段 chunk）', HttpStatus.BAD_REQUEST);
      return;
    }

    const uploadId = req.params.uploadId ?? '';
    const index = Number.parseInt(req.params.index ?? '', 10);

    const result = await aiDetectService.getChunkUpload(uploadId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }

    const data: ChunkUpload.ReceiveResult = { index, session: result.data };
    res.sendSuccess(data, '分片上传成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '分片上传失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiDetect/scene/chunks/:uploadId — 查询分片上传进度（已收下标，供断点续传） */
export const getSceneChunkStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await aiDetectService.getChunkUpload(req.params.uploadId ?? '');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询分片上传进度失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/aiDetect/scene/chunks/:uploadId — 放弃分片上传（删除会话目录与已收分片） */
export const abortSceneChunkUpload = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await aiDetectService.abortChunkUpload(req.params.uploadId ?? '');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(null, '分片上传已取消');
  } catch (err) {
    const message = err instanceof Error ? err.message : '取消分片上传失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * GET /api/aiDetect/scene/tasks — 分页查询场景切分任务
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
    const parsedPage = optionalNumber(page);
    const parsedLimit = optionalNumber(limit);
    const query: AiDetect.TaskQuery = {
      ...(optionalString(status) ? { status: optionalString(status) as AiDetect.TaskStatus } : {}),
      ...(parsedPage !== undefined ? { page: parsedPage } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    };

    const result = await aiDetectService.listTasks(userId, query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询场景切分任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * GET /api/aiDetect/scene/tasks/:taskId — 任务详情与进度
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 * 成功后返回 scenes（场景时间段）。
 */
export const getTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiDetectService.getTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询场景切分任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiDetect/scene/tasks/queue/status — 场景切分队列的计数（总数 / 等待中 / 运行中）
 *  只统计场景切分任务；抽帧是另一条独立队列，见 /frames/tasks/queue/status。 */
export const getTaskQueueStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await aiDetectService.getQueueStatus('scene');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询队列状态失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * GET /api/aiDetect/scene/tasks/:taskId/queue — 排队位置
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 */
export const getTaskQueuePosition = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiDetectService.getQueuePosition(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询排队位置失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/aiDetect/scene/tasks/:taskId/cancel — 取消排队中的场景切分任务
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 * 仅 pending 可取消，已在运行/已终结的任务返回 409。
 */
export const cancelTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiDetectService.cancel(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '任务已取消');
  } catch (err) {
    const message = err instanceof Error ? err.message : '取消场景切分任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/aiDetect/scene/tasks/:taskId/merge — 按场景序号分组合并（同步接口）
 *
 * 入参（JSON）：groups = [[1,2],[3,4,5]]，每个分组 ≥2 个**连续**的场景序号，组内并成一个新场景，
 * 未出现在任何分组里的场景原样保留。
 * 与抽帧/转写的差别：不建任务、不入队，但**会把结果写回该场景任务**（scenes/sceneCount 被覆盖，
 * 原划分不可撤销），故它是一次破坏性操作；序号始终指任务当前划分，可反复调用。
 * 已有抽帧/转写任务的任务拒绝合并（409）。
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 */
export const mergeScenes = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await aiDetectService.mergeScenes(taskId, userId, body.groups);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '场景合并成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '场景合并失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiDetect/scene/engine/status — 场景切分队列的引擎状态（开关、leader、队列深度、并发、最近进度） */
export const getEngineStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await aiDetectService.getEngineStatus('scene');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询引擎状态失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

// ---- AI 检测：场景关键帧抽帧 ----
// 抽帧的输入是「已完成的场景切分任务」而不是源视频，故这一组接口不接上传、也没有分片上传 ——
// 请求体只有一个 taskId。抽帧在自己的表与队列上执行，故队列/引擎状态也各有一套（见文件末尾）。

/**
 * POST /api/aiDetect/frames/tasks — 提交场景抽帧任务
 * （JSON：taskId 必填，为已完成的场景切分任务 id；可选 userId）
 *
 * 提交只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行
 * 「逐场景抽开始/中间/结束帧 → 逐帧登记 file 表」，客户端轮询 GET /frames/tasks/:taskId。
 */
export const submitFrameTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskId = optionalString(body.taskId) ?? '';
    if (!taskId) {
      res.sendFail('taskId 为必填字段（已完成的场景切分任务 id）', HttpStatus.BAD_REQUEST);
      return;
    }

    const userId = resolveUserId(req) ?? '';
    const result = await aiDetectService.submitFramesTask(taskId, userId ? { userId } : {});
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '抽帧任务已提交');
  } catch (err) {
    const message = err instanceof Error ? err.message : '提交抽帧任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * GET /api/aiDetect/frames/tasks — 分页查询抽帧任务
 * （query：userId 精确可选，缺省回退当前登录用户；status 可选；page/limit）
 */
export const listFrameTasks = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { status, page, limit } = req.query;
    const statusValue = optionalString(status);
    const parsedPage = optionalNumber(page);
    const parsedLimit = optionalNumber(limit);
    const query: AiDetect.FrameTaskQuery = {
      ...(statusValue ? { status: statusValue as AiDetect.TaskStatus } : {}),
      ...(parsedPage !== undefined ? { page: parsedPage } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    };

    const result = await aiDetectService.listFrameTasks(userId, query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询抽帧任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * GET /api/aiDetect/frames/tasks/:taskId — 抽帧任务详情与进度
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 * 成功后返回 frames（每个场景的 开始/中间/结束 帧及其 fileId/url）。
 */
export const getFrameTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiDetectService.getFrameTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询抽帧任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * GET /api/aiDetect/frames/tasks/:taskId/queue — 排队位置
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 * 队列由场景切分与抽帧共用，故 position 按两类任务合计的 FIFO 顺序计算。
 */
export const getFrameTaskQueuePosition = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiDetectService.getQueuePosition(taskId, userId, 'frames');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询排队位置失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/aiDetect/frames/tasks/:taskId/cancel — 取消排队中的抽帧任务
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 * 仅 pending 可取消，已在运行/已终结的任务返回 409。
 */
export const cancelFrameTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiDetectService.cancelFrameTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '抽帧任务已取消');
  } catch (err) {
    const message = err instanceof Error ? err.message : '取消抽帧任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiDetect/frames/tasks/queue/status — 抽帧队列的计数（总数 / 等待中 / 运行中） */
export const getFrameTaskQueueStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await aiDetectService.getQueueStatus('frames');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询队列状态失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiDetect/frames/engine/status — 抽帧队列的引擎状态（开关、leader、队列深度、并发、最近进度）
 *  与场景侧的同类接口各报各的：并发上限是 AI_DETECT_FRAME_CONCURRENCY，进度只在抽帧任务推进时变化。 */
export const getFrameEngineStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await aiDetectService.getEngineStatus('frames');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询引擎状态失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

// ---- AI 检测：场景语音转写 ----
// 与抽帧同构：入参也是「已完成的场景切分任务 id」，不接上传。区别是执行时会把音频块交给
// subtitle 模块转写，故产物是「按场景归并好的文本段」而不是文件。

/**
 * POST /api/aiDetect/asr/tasks — 提交场景转写任务
 * （JSON：taskId 必填，为已完成的场景切分任务 id；可选 userId）
 *
 * 提交只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行
 * 「按固定时长切块抽音频 → 逐块走 subtitle 的 Whisper 链路 → 按场景归并文本」，
 * 客户端轮询 GET /asr/tasks/:taskId（进度按块推进）。
 */
export const submitAsrTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskId = optionalString(body.taskId) ?? '';
    if (!taskId) {
      res.sendFail('taskId 为必填字段（已完成的场景切分任务 id）', HttpStatus.BAD_REQUEST);
      return;
    }

    const userId = resolveUserId(req) ?? '';
    const result = await aiDetectService.submitAsrTask(taskId, userId ? { userId } : {});
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '转写任务已提交');
  } catch (err) {
    const message = err instanceof Error ? err.message : '提交转写任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * GET /api/aiDetect/asr/tasks — 分页查询转写任务
 * （query：userId 精确可选，缺省回退当前登录用户；status 可选；page/limit）
 */
export const listAsrTasks = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { status, page, limit } = req.query;
    const statusValue = optionalString(status);
    const parsedPage = optionalNumber(page);
    const parsedLimit = optionalNumber(limit);
    const query: AiDetect.AsrTaskQuery = {
      ...(statusValue ? { status: statusValue as AiDetect.TaskStatus } : {}),
      ...(parsedPage !== undefined ? { page: parsedPage } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    };

    const result = await aiDetectService.listAsrTasks(userId, query);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询转写任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * GET /api/aiDetect/asr/tasks/:taskId — 转写任务详情与进度
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 * 成功后返回 segments（全局扁平）与 sceneSegments（按场景归组）两份文本。
 */
export const getAsrTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiDetectService.getAsrTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询转写任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * GET /api/aiDetect/asr/tasks/:taskId/queue — 排队位置
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 * 只算转写队列：场景切分与抽帧的排队互不影响。
 */
export const getAsrTaskQueuePosition = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiDetectService.getQueuePosition(taskId, userId, 'asr');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询排队位置失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/aiDetect/asr/tasks/:taskId/cancel — 取消排队中的转写任务
 * （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
 * 仅 pending 可取消，已在运行/已终结的任务返回 409。
 */
export const cancelAsrTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { taskId } = req.params;
    if (!taskId) {
      res.sendFail('缺少任务 id', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await aiDetectService.cancelAsrTask(taskId, userId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '转写任务已取消');
  } catch (err) {
    const message = err instanceof Error ? err.message : '取消转写任务失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiDetect/asr/tasks/queue/status — 转写队列的计数（总数 / 等待中 / 运行中） */
export const getAsrTaskQueueStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await aiDetectService.getQueueStatus('asr');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询队列状态失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/aiDetect/asr/engine/status — 转写队列的引擎状态（开关、leader、队列深度、并发、最近进度）
 *  并发上限是 AI_DETECT_ASR_CONCURRENCY；注意真正的算力闸门在 subtitle 侧（SUBTITLE_CONCURRENCY）。 */
export const getAsrEngineStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await aiDetectService.getEngineStatus('asr');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询引擎状态失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
