import type { Request, Response } from 'express';
import { voiceTrainService } from './voiceTrain.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import type { CreatePipelineTaskDto, CreateVoiceTrainTaskDto, GetTrainResultDto, PipelineTaskQueryDto, RaasrTranscribeDto, SubmitAudioDto, SubmitTrainWithAudioDto, SynthesizeAudioDto, UpdateVoiceTrainResultDto, VoiceTrainResultQueryDto } from './voiceTrain.dto.ts';

/** POST /api/voiceTrain/texts — 获取训练样本 */
export const getTrainTexts = async (req: Request, res: Response): Promise<void> => {
    const result = await voiceTrainService.getTexts();
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    const data = {
        ...result.data,
        full_text: result.data.textSegs.map(text => text.segText).toString()
    }
    res.sendSuccess(data, '获取训练样本成功',);
};


/** POST /api/voiceTrain/task — 创建训练任务 */
export const createTrainTask = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Record<string, string | number | undefined>;

    const dto: CreateVoiceTrainTaskDto = {};
    if (body.taskName !== undefined && body.taskName !== '') dto.taskName = String(body.taskName);
    if (body.sex !== undefined && body.sex !== '') dto.sex = Number(body.sex);
    if (body.ageGroup !== undefined && body.ageGroup !== '') dto.ageGroup = Number(body.ageGroup);
    if (body.resourceType !== undefined && body.resourceType !== '') dto.resourceType = Number(body.resourceType);
    if (body.thirdUser !== undefined && body.thirdUser !== '') dto.thirdUser = String(body.thirdUser);
    if (body.language !== undefined && body.language !== '') dto.language = String(body.language);
    if (body.denoise !== undefined && body.denoise !== '') dto.denoise = Number(body.denoise);
    if (body.mosRatio !== undefined && body.mosRatio !== '') dto.mosRatio = body.mosRatio;
    if (body.resourceName !== undefined && body.resourceName !== '') dto.resourceName = String(body.resourceName);
    if (body.callbackUrl !== undefined && body.callbackUrl !== '') dto.callbackUrl = String(body.callbackUrl);

    const result = await voiceTrainService.createTask(dto);
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.taskId, '创建训练任务成功');
};

/** POST /api/voiceTrain/audio — 上传音频并提交训练 */
export const submitAudio = async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
        res.sendFail('请选择要上传的音频文件', HttpStatus.BAD_REQUEST);
        return;
    }

    const body = req.body as Record<string, string | undefined>;
    const taskId = body.taskId;
    const textSegId = body.textSegId;
    if (!taskId || !textSegId) {
        res.sendFail('taskId、textSegId 为必填字段', HttpStatus.BAD_REQUEST);
        return;
    }

    const dto: SubmitAudioDto = {
        taskId,
        textSegId,
        ...(body.textId ? { textId: body.textId } : {}),
        ...(body.mosRatio ? { mosRatio: body.mosRatio } : {}),
    };

    const result = await voiceTrainService.submitAudio(file, dto);
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '上传音频并提交训练成功');
};

/** POST /api/voiceTrain/task/submit — 上传音频并自动创建训练任务（multipart：userId/file/textSegId/resourceName/textId） */
export const createAndSubmitAudio = async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
        res.sendFail('请选择要上传的音频文件', HttpStatus.BAD_REQUEST);
        return;
    }

    const body = req.body as Record<string, string | undefined>;
    const userId = body.userId;
    const textSegId = body.textSegId;
    const resourceName = typeof body.resourceName === 'string' ? body.resourceName.trim() : '';
    const sex =  parseInt(body.sex as string);
    const textId =  body.textId;
    if (!userId || !textSegId || !resourceName ||!sex||!textId) {
        res.sendFail('userId、textSegId、resourceName、textId、sex 为必填字段', HttpStatus.BAD_REQUEST);
        return;
    }

    const dto: SubmitTrainWithAudioDto = {
        userId,
        textSegId,
        resourceName,
        sex,
        textId,
        ...(body.mosRatio ? { mosRatio: body.mosRatio } : {}),
    };

    const result = await voiceTrainService.createAndSubmitAudio(file, dto);
    if ('error' in result) {
        const isLimit = result.error.includes('已达上限');
        res.sendFail(result.error, isLimit ? HttpStatus.BAD_REQUEST : HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '创建训练任务并上传音频成功');
};

/** POST /api/voiceTrain/result — 查询训练结果（成功取到非空结果时落库关联 userId，userId 由用户上传，未传时回退 JWT） */
export const getTrainResult = async (req: Request, res: Response): Promise<void> => {
    const dto = req.body as GetTrainResultDto;
    if (!dto.taskId) {
        res.sendFail('taskId 为必填字段', HttpStatus.BAD_REQUEST);
        return;
    }

    const userId = req.jwtPayload?.id as string;
    if(!userId) return res.sendFail('获取训练结果成功',HttpStatus.UNAUTHORIZED)
    const result = await voiceTrainService.getResult(dto.taskId, userId);
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '获取训练结果成功');
};

/** GET /api/voiceTrain/results — 分页查询用户的训练结果（userId 由用户上传，未传时回退 JWT） */
export const getVoiceTrainResults = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.query.userId as string) || ((req.jwtPayload?.id as string) || '');
    if (!userId) {
        res.sendFail('未登录或登录已过期', HttpStatus.UNAUTHORIZED);
        return;
    }

    const { page, limit } = req.query;
    const query: VoiceTrainResultQueryDto = {
        ...(page ? { page: parseInt(page as string, 10) } : {}),
        ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await voiceTrainService.getUserResults(userId, query);
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '查询训练结果成功');
};

/** GET /api/voiceTrain/results/public — 分页查询公共训练记录（userId 为空/缺失的未删除记录，不限用户） */
export const getPublicTrainResults = async (req: Request, res: Response): Promise<void> => {
    const { page, limit } = req.query;
    const query: VoiceTrainResultQueryDto = {
        ...(page ? { page: parseInt(page as string, 10) } : {}),
        ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await voiceTrainService.getPublicResults(query);
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '查询公共训练结果成功');
};

/** GET /api/voiceTrain/results/all — 分页查询全部训练记录（未删除，不限定 userId，含公共记录） */
export const getAllTrainResults = async (req: Request, res: Response): Promise<void> => {
    const { page, limit } = req.query;
    const query: VoiceTrainResultQueryDto = {
        ...(page ? { page: parseInt(page as string, 10) } : {}),
        ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
    };

    const result = await voiceTrainService.getAllResults(query);
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '查询全部训练结果成功');
};

/** PUT /api/voiceTrain/result — 修改训练记录的音色名称（仅允许改 resourceName，不校验归属） */
export const updateTrainResultResourceName = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Partial<UpdateVoiceTrainResultDto>;
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    const resourceName = typeof body.resourceName === 'string' ? body.resourceName.trim() : '';
    if (!taskId) {
        res.sendFail('taskId 为必填字段', HttpStatus.BAD_REQUEST);
        return;
    }
    if (!resourceName) {
        res.sendFail('resourceName 不能为空', HttpStatus.BAD_REQUEST);
        return;
    }

    const result = await voiceTrainService.renameResult(taskId, resourceName);
    if ('error' in result) {
        res.sendFail(result.error, result.error === '训练记录不存在' ? HttpStatus.NOT_FOUND : HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '修改音色名称成功');
};

/** POST /api/voiceTrain/synthesize — 提交音频合成任务（异步，立即返回 taskId） */
export const synthesizeAudio = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Record<string, string | number | undefined>;

    const resId = body.resId;
    const text = body.text;
    if (typeof resId !== 'string' || resId === '' || typeof text !== 'string' || text === '') {
        res.sendFail('resId、text 为必填字段', HttpStatus.BAD_REQUEST);
        return;
    }

    const dto: SynthesizeAudioDto = { resId, text };
    if (body.speed !== undefined && body.speed !== '') dto.speed = Number(body.speed);
    if (body.volume !== undefined && body.volume !== '') dto.volume = Number(body.volume);
    if (body.pitch !== undefined && body.pitch !== '') dto.pitch = Number(body.pitch);
    if (body.language !== undefined && body.language !== '') dto.language = Number(body.language);
    if (typeof body.encoding === 'string' && body.encoding !== '') dto.encoding = body.encoding;
    if (body.sampleRate !== undefined && body.sampleRate !== '') dto.sampleRate = Number(body.sampleRate);

    const result = await voiceTrainService.synthesize(dto);
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '合成任务已提交');
};

/** GET /api/voiceTrain/synthesize/:taskId — 查询合成任务状态/结果 */
export const getSynthesisStatus = async (req: Request, res: Response): Promise<void> => {
    const { taskId } = req.params;
    if (!taskId) {
        res.sendFail('taskId 为必填字段', HttpStatus.BAD_REQUEST);
        return;
    }

    const result = await voiceTrainService.getSynthesisTask(taskId);
    if ('error' in result) {
        const notFound = result.error === '合成任务不存在';
        res.sendFail(result.error, notFound ? HttpStatus.NOT_FOUND : HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '查询合成任务成功');
};

/** POST /api/voiceTrain/task/pipeline — 提交视频生成任务（异步，立即返回 taskId） */
export const taskPipeLine = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Record<string, string | number | undefined>;

    const resId = body.resId;
    const text = body.text;
    if (typeof resId !== 'string' || resId === '' || typeof text !== 'string' || text === '') {
        res.sendFail('resId、text 为必填字段', HttpStatus.BAD_REQUEST);
        return;
    }

    const dto: CreatePipelineTaskDto = { resId, text };
    if (body.speed !== undefined && body.speed !== '') dto.speed = Number(body.speed);
    if (body.volume !== undefined && body.volume !== '') dto.volume = Number(body.volume);
    if (body.pitch !== undefined && body.pitch !== '') dto.pitch = Number(body.pitch);
    if (body.language !== undefined && body.language !== '') dto.language = Number(body.language);
    if (typeof body.encoding === 'string' && body.encoding !== '') dto.encoding = body.encoding;
    if (body.sampleRate !== undefined && body.sampleRate !== '') dto.sampleRate = Number(body.sampleRate);
    if (typeof body.color === 'string' && body.color !== '') dto.color = body.color;
    // keywords：兼容数组或 JSON 字符串，过滤空串、单词 ≤50 字符、总量 ≤200
    if (body.keywords !== undefined && body.keywords !== '') {
        let raw: unknown = body.keywords;
        if (typeof raw === 'string') {
            try { raw = JSON.parse(raw); } catch { raw = null; }
        }
        if (Array.isArray(raw)) {
            const cleaned = raw
                .filter((k): k is string => typeof k === 'string' && k.trim() !== '')
                .map((k) => k.trim().slice(0, 50))
                .slice(0, 200);
            if (cleaned.length) dto.keywords = cleaned;
        }
    }
    // 归属：body.userId 优先，回退 JWT 载荷 id（任务与用户挂钩）
    const userId = (typeof body.userId === 'string' && body.userId !== '' ? body.userId : '') || ((req.jwtPayload?.id as string) || '');
    if (userId) dto.userId = userId;

    const result = await voiceTrainService.createPipelineTask(dto);
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '视频生成任务已提交');
};

/** GET /api/voiceTrain/task/pipeline/:taskId — 查询视频生成任务状态/结果（归属校验：绑定用户的任务仅本人可查） */
export const getPipelineStatus = async (req: Request, res: Response): Promise<void> => {
    const { taskId } = req.params;
    if (!taskId) {
        res.sendFail('taskId 为必填字段', HttpStatus.BAD_REQUEST);
        return;
    }

    // 归属：query.userId 优先，回退 JWT 载荷 id
    const userId = (req.query.userId as string) || ((req.jwtPayload?.id as string) || '');
    const result = await voiceTrainService.getPipelineTask(taskId, userId || undefined);
    if ('error' in result) {
        if (result.error === '视频生成任务不存在') {
            res.sendFail(result.error, HttpStatus.NOT_FOUND);
            return;
        }
        if (result.error === '无权访问该视频生成任务') {
            res.sendFail(result.error, HttpStatus.FORBIDDEN);
            return;
        }
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '查询视频生成任务成功');
};

/** GET /api/voiceTrain/task/pipeline — 分页查询当前用户的视频生成任务（userId 由用户上传，未传时回退 JWT） */
/** GET /api/voiceTrain/task/pipeline/queue/status — 视频合成任务队列实时状态（无需鉴权归属） */
export const getPipelineQueueStatus = async (_req: Request, res: Response): Promise<void> => {
    const result = await voiceTrainService.getPipelineQueueStatus();
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '获取视频合成队列状态成功');
};

export const listPipelineTasks = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.query.userId as string) || ((req.jwtPayload?.id as string) || '');
    if (!userId) {
        res.sendFail('未登录或登录已过期', HttpStatus.UNAUTHORIZED);
        return;
    }

    const { page, limit, taskId } = req.query;
    const query: PipelineTaskQueryDto = {
        ...(page ? { page: parseInt(page as string, 10) } : {}),
        ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
        ...(taskId ? { taskId: taskId as string } : {}),
    };

    const result = await voiceTrainService.getUserPipelineTasks(userId, query);
    if ('error' in result) {
        res.sendFail(result.error, HttpStatus.ERROR);
        return;
    }
    res.sendSuccess(result.data, '查询视频生成任务列表成功');
};

/** POST /api/voiceTrain/raasr — 录音文件转写（同步，上传后轮询至完成，直接返回转写文本） */
export const transcribeRaasr = async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
        res.sendFail('请选择要上传的音频文件', HttpStatus.BAD_REQUEST);
        return;
    }

    const body = req.body as Record<string, string | undefined>;
    const dto: RaasrTranscribeDto = {};
    if (body.duration !== undefined && body.duration !== '') dto.duration = Number(body.duration);
    if (body.language !== undefined && body.language !== '') dto.language = String(body.language);
    if (body.roleType !== undefined && body.roleType !== '') dto.roleType = Number(body.roleType);
    if (body.callbackUrl !== undefined && body.callbackUrl !== '') dto.callbackUrl = String(body.callbackUrl);

    const result = await voiceTrainService.transcribeRaasr(dto, file);
    // if ('error' in result) {
    //     res.sendFail(result.error, HttpStatus.ERROR);
    //     return;
    // }
    res.sendSuccess(result, '录音转写完成');
};
// POST /api/voiceTrain/raasr/result — 云端获取录音文件转写结果
export const raastResult = async (req: Request, res: Response): Promise<void> => {
    const { orderId, signatureRandom, resultType } = req.query
    if (!orderId || !signatureRandom || !resultType) return res.sendFail('参数错误', HttpStatus.ERROR)
    const result = await voiceTrainService.raastResult(orderId as string, signatureRandom as string, resultType as string);
    res.sendSuccess(result, '云端获取录音文件转写结果成功');
};

/**
 * 讯飞音色训练完成回调（公网推送，免鉴权，注册在 app.ts 的 /hip/api JWT 挂载之前）。
 * 始终 ack 2xx（绕过 sendSuccess 包装）：落库失败也 ack，避免讯飞无限重试；可依赖 /result 轮询兜底。
 */
export const trainsCallback = async (req: Request, res: Response): Promise<void> => {
    await voiceTrainService.handleTrainCallback(req.body, req.query as Record<string, unknown>);
    res.status(HttpStatus.SUCCESS).send('ok');
};



