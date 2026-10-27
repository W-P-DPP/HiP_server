import { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { voiceTrainV2VoiceService } from './voiceTrainV2Voice.service.ts';
import { voiceTrainV2SynthesisService } from './voiceTrainV2Synthesis.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import type { VoiceTrainV2 } from '../../type/index.d.ts';

/**
 * 解析本次请求的目标用户 id：显式传入（query.userId 优先，其次 body.userId）> JWT 登录身份。
 *
 * 显式传参允许以指定 userId 提交/查询合成任务（与音色库 listVoices 同口径），便于服务端/脚本
 * 不带 JWT 用户身份时按 userId 直连。多处接口共用同一口径，避免各写一套回退逻辑。
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

/** POST /api/voiceTrainV2/voices — 上传训练音频并创建音色（multipart：file/resourceName 必填，promptText/userId 可选） */
export const createVoice = async (req: Request, res: Response): Promise<void> => {
    try {
        const file = req.file;
        if (!file) {
            res.sendFail('请选择要上传的音频文件', HttpStatus.BAD_REQUEST);
            return;
        }

        const body = req.body as Record<string, string | undefined>;
        // 归属用户优先取请求体 userId，缺省回退 JWT
        const userId = body.userId || (req.jwtPayload?.id as string | undefined) || '';

        const dto: VoiceTrainV2.CreateVoiceUploadDto = {
            resourceName: body.resourceName ?? '',
            ...(body.promptText ? { promptText: body.promptText } : {}),
            ...(userId ? { userId } : {}),
        };

        const result = await voiceTrainV2VoiceService.createVoice(file, dto);
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '音色创建成功');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '音色创建失败', HttpStatus.ERROR);
    }
};

/** GET /api/voiceTrainV2/voices — 分页查询音色（query：userId 精确 + resourceName 模糊，均可选；page/limit） */
export const listVoices = async (req: Request, res: Response): Promise<void> => {
    try {
        const { userId, resourceName, page, limit } = req.query;

        const query: VoiceTrainV2.VoiceQuery = {
            ...(typeof userId === 'string' && userId.trim() ? { userId: userId.trim() } : {}),
            ...(typeof resourceName === 'string' && resourceName.trim() ? { resourceName: resourceName.trim() } : {}),
            ...(page ? { page: parseInt(page as string, 10) } : {}),
            ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
        };

        const result = await voiceTrainV2VoiceService.listVoices(query);
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '查询音色成功');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '查询音色失败', HttpStatus.ERROR);
    }
};

/** GET /api/voiceTrainV2/voices/:id — 查询音色详情 */
export const getVoice = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        if (!id) {
            res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
            return;
        }

        const result = await voiceTrainV2VoiceService.getVoice(id);
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '查询音色成功');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '查询音色失败', HttpStatus.ERROR);
    }
};

/** PUT /api/voiceTrainV2/voices/:id — 修改音色名称（body：resourceName，仅当前用户自己的记录） */
export const renameVoice = async (req: Request, res: Response): Promise<void> => {
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
        const result = await voiceTrainV2VoiceService.renameVoice(id, userId, body.resourceName ?? '');
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '音色名称修改成功');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '音色名称修改失败', HttpStatus.ERROR);
    }
};

/** DELETE /api/voiceTrainV2/voices/:id — 删除音色（假删除，仅当前用户自己的记录） */
export const deleteVoice = async (req: Request, res: Response): Promise<void> => {
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

        const result = await voiceTrainV2VoiceService.removeVoice(id, userId);
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '删除音色成功');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '删除音色失败', HttpStatus.ERROR);
    }
};

// ---- 合成（试听） ----
// 提交只建任务，由 leader dispatcher 异步执行；客户端轮询 GET /synthesize/:taskId 取进度。

/**
 * POST /api/voiceTrainV2/synthesize — 提交克隆音色合成任务
 * （body：voiceId 必填；text/speedMode 可选；purpose 可选，preview=试听 / synthesis=正式合成，缺省 synthesis）
 *
 * 只有 purpose=preview 的任务成功后会回写音色的试听字段（列表里可播放的那个）。
 */
export const submitSynthesis = async (req: Request, res: Response): Promise<void> => {
    try {
        const body = req.body as Record<string, string | undefined>;
        // 归属用户优先取显式 userId（query 优先、其次 body），缺省回退 JWT
        const userId = resolveUserId(req) ?? '';

        const dto: VoiceTrainV2.SynthesizeDto = {
            voiceId: body.voiceId ?? '',
            ...(body.text ? { text: body.text } : {}),
            ...(body.speedMode ? { speedMode: body.speedMode } : {}),
            ...(body.purpose ? { purpose: body.purpose as VoiceTrainV2.SynthesisPurpose } : {}),
            ...(userId ? { userId } : {}),
        };

        const result = await voiceTrainV2SynthesisService.submit(dto);
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '合成任务已提交');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '合成任务提交失败', HttpStatus.ERROR);
    }
};

/** GET /api/voiceTrainV2/synthesize — 分页查询当前用户的合成任务（query：status 可选；page/limit） */
export const listSynthesisTasks = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.jwtPayload?.id as string | undefined;
        if (!userId) {
            res.sendFail('未获取到当前用户身份', HttpStatus.UNAUTHORIZED);
            return;
        }

        const { status, page, limit } = req.query;
        const query: VoiceTrainV2.SynthesisTaskQuery = {
            ...(typeof status === 'string' && status.trim() ? { status: status.trim() as VoiceTrainV2.SynthesisStatus } : {}),
            ...(page ? { page: parseInt(page as string, 10) } : {}),
            ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
        };

        const result = await voiceTrainV2SynthesisService.listTasks(userId, query);
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '查询合成任务成功');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '查询合成任务失败', HttpStatus.ERROR);
    }
};

/** GET /api/voiceTrainV2/synthesize/:taskId — 查询合成任务详情与进度（仅任务归属用户） */
export const getSynthesisTask = async (req: Request, res: Response): Promise<void> => {
    try {
        const { taskId } = req.params;
        if (!taskId) {
            res.sendFail('非法的 taskId 参数', HttpStatus.BAD_REQUEST);
            return;
        }

        // 目标用户优先取显式 userId（query 优先、其次 body），缺省回退 JWT
        const userId = resolveUserId(req);
        if (!userId) {
            res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
            return;
        }

        const result = await voiceTrainV2SynthesisService.getTask(taskId, userId);
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '查询合成任务成功');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '查询合成任务失败', HttpStatus.ERROR);
    }
};

/**
 * POST /api/voiceTrainV2/synthesize/:taskId/cancel — 取消排队中的音色合成任务
 * （query：userId 可选，缺省回退 JWT；须与任务归属一致）
 *
 * 仅 status=pending 的任务可取消；已被调度器领取执行或已进入终态的一律拒绝。
 */
export const cancelSynthesisTask = async (req: Request, res: Response): Promise<void> => {
    try {
        const { taskId } = req.params;
        if (!taskId) {
            res.sendFail('非法的 taskId 参数', HttpStatus.BAD_REQUEST);
            return;
        }

        // 目标用户优先取显式 userId（query 优先、其次 body），缺省回退 JWT
        const userId = resolveUserId(req);
        if (!userId) {
            res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
            return;
        }

        const result = await voiceTrainV2SynthesisService.cancel(taskId, userId);
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '任务已取消');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '取消任务失败', HttpStatus.ERROR);
    }
};

/** GET /api/voiceTrainV2/synthesize/:taskId/queue — 查询合成任务的排队位置（仅任务归属用户） */
export const getSynthesisQueuePosition = async (req: Request, res: Response): Promise<void> => {
    try {
        const { taskId } = req.params;
        if (!taskId) {
            res.sendFail('非法的 taskId 参数', HttpStatus.BAD_REQUEST);
            return;
        }

        // 目标用户优先取显式 userId（query 优先、其次 body），缺省回退 JWT
        const userId = resolveUserId(req);
        if (!userId) {
            res.sendFail('未获取到查询用户身份', HttpStatus.UNAUTHORIZED);
            return;
        }

        const result = await voiceTrainV2SynthesisService.getQueuePosition(taskId, userId);
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
 * GET /api/voiceTrainV2/synthesize/queue/status — 音色合成任务队列计数
 * （全局口径，无需归属鉴权：总数 / 等待中 / 运行中，跨 worker 一致）
 */
export const getSynthesisQueueStatus = async (_req: Request, res: Response): Promise<void> => {
    try {
        const result = await voiceTrainV2SynthesisService.getQueueStatus();
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '查询音色合成任务队列计数成功');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '查询音色合成任务队列计数失败', HttpStatus.ERROR);
    }
};

/**
 * GET /api/voiceTrainV2/engine/status — IndexTTS 引擎状态。
 * 只报引擎自身状态；GPU 利用率/显存请调用 GET /api/system/resources，此处不重复实现。
 */
export const getEngineStatus = async (_req: Request, res: Response): Promise<void> => {
    try {
        const result = await voiceTrainV2SynthesisService.getEngineStatus();
        if ('error' in result) {
            res.sendFail(result.error, result.code);
            return;
        }
        res.sendSuccess(result.data, '查询引擎状态成功');
    } catch (err) {
        res.sendFail(err instanceof Error ? err.message : '查询引擎状态失败', HttpStatus.ERROR);
    }
};
