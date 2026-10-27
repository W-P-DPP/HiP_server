import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { isValidObjectId } from 'mongoose';
import { Logger } from '../../utils/Logger.ts';
import type { RaasrGetResultResponse, XunfeiTrainResultDto } from '../../utils/xunfei/xunfei.d.ts';
import { trainCreate } from '../../utils/xunfei/trainCreate.ts';
import { submitWithAudio } from '../../utils/xunfei/SubmitWithAudio.ts';
import { getTrainResult } from '../../utils/xunfei/getTrainResult.ts';
import { getTrainText } from '../../utils/xunfei/getTrainText.ts';
import { voiceCloneSynthesis } from '../../utils/xunfei/vioceClone.ts';
import { arrast_upload, arrast_result } from '../../utils/xunfei/raast.ts';
import { parseRaasrText, parseRaasrSrt, signatureRandomString, RAASR_RESULT_TYPE } from '../../utils/xunfei/raasrHelpers.ts';
import { toVideo } from '../../utils/videoHelper/toVideo.ts';
import { parseSrt } from '../../utils/videoHelper/srt.ts';
import { buildBackgroundTrack } from '../../utils/videoHelper/background.ts';
import { probeDurationMs } from '../../utils/videoHelper/probe.ts';
import { similarityScore } from '../../utils/videoHelper/similarity.ts';
import { fileService } from '../file/file.service.ts';
import fileConfig from '../file/file.config.ts';
import type { FileDocument } from '../file/file.entity.ts';
import { voiceSynthesisTaskRepository } from './voiceSynthesisTask.repository.ts';
import { voicePipelineTaskRepository } from './voicePipelineTask.repository.ts';
import { voiceTrainResultRepository } from './voiceTrainResult.repository.ts';
import { AsyncQueue } from '../../utils/AsyncQueue.ts';
import { RedisSemaphore } from '../../utils/RedisSemaphore.ts';
import RedisService from '../../utils/Redis.ts';
import { registerShutdownHook } from '../../utils/shutdownHooks.ts';
import { getWorkerId } from '../../utils/clusterConfig.ts';
import { RECOVERY_LOCK_PREFIX, RECOVERY_LOCK_TTL, RECOVERY_STALE_THRESHOLD_MS } from '../../utils/constant/ClusterConstants.ts';
import { XunfeiConstants } from '../../utils/constant/XunfeiConstants.ts';
import { MaterialConstants } from '../../utils/constant/MaterialConstants.ts';
import { VideoTaskConstants } from '../../utils/constant/video.ts';
import { VoiceTrainConstants } from '../../utils/constant/VoiceTrainConstants.ts';
import type { VoiceTrainResultDocument } from './voiceTrainResult.entity.ts';
import type { VoicePipelineTaskDocument } from './voicePipelineTask.entity.ts';
import { normalizeTrainCallback } from './trainCallback.normalize.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';
import type {
    CreatePipelineTaskDto,
    CreateVoiceTrainTaskDto,
    PipelineTaskItemDto,
    PipelineTaskQueryDto,
    PipelineTaskResult,
    PipelineTaskSubmitResult,
    PipelineQueueStatusDto,
    RaasrTranscribeDto,
    RaasrTranscribeResult,
    SubmitAudioDto,
    SubmitTrainWithAudioDto,
    SynthesizeAudioDto,
    SynthesizeResult,
    SynthesisSubmitResult,
    SynthesisTaskResult,
    VoiceTrainResultItemDto,
    VoiceTrainResultQueryDto,
} from './voiceTrain.dto.ts';

const logger = Logger.getInstance();

/** 视频合成任务队列：并发上限由 VIDEO_TASK_CONCURRENCY 控制（默认 1 = 每次只处理一次视频合成） */
const videoTaskQueue = new AsyncQueue(VideoTaskConstants.CONCURRENCY);

/** 视频合成全局信号量：跨进程把 ffmpeg 合成并发锁回 VIDEO_TASK_CONCURRENCY（每 worker 本地队列只是本地顺序） */
const videoSemaphore = new RedisSemaphore('video', VideoTaskConstants.CONCURRENCY);

/** 音色名称匹配阈值（与素材匹配一致）：resourceName 与 res 相似度 ≥0.6 才视为命中 */
const VOICE_RES_MATCH_THRESHOLD = 0.6;
/** 未显式传 res 时的默认音色名称（对应公共池女声记录） */
const DEFAULT_VOICE_RES_NAME = '公共女生';
/** 单用户未删除训练记录数上限（可经 VOICE_TRAIN_MAX_PER_USER 覆盖，默认 10，下限 1） */
const MAX_USER_TRAIN_RESULTS = VoiceTrainConstants.MAX_PER_USER;

// 优雅退出时排空本地视频任务队列
registerShutdownHook(() => videoTaskQueue.drain());

/** 音频编码 → 扩展名 / MIME */
const encodingMap: Record<string, { ext: string; mime: string }> = {
    lame: { ext: '.mp3', mime: 'audio/mpeg' },
    raw: { ext: '.pcm', mime: 'audio/x-pcm' },
    opus: { ext: '.opus', mime: 'audio/opus' },
    speex: { ext: '.speex', mime: 'audio/x-speex' },
};

/** 录音转写轮询上限（严格低于讯飞 getResult 100 次/订单配额） */
const MAX_RAASR_POLL_COUNT = 90;
/** 录音转写轮询间隔（毫秒） */
const RAASR_POLL_INTERVAL_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 背景色规整：色名透传，#RRGGBB → 0xRRGGBB（ffmpeg lavfi color 解析），非法输入回落 black。
 * 白名单仅允许 #、数字、字母，隔离冒号/逗号/分号等滤镜分隔符注入。
 */
export function sanitizeColor(color?: string): string {
    if (!color) return 'black';
    const t = color.trim();
    if (!/^[#0-9a-zA-Z]+$/.test(t)) return 'black';
    return t.startsWith('#') ? `0x${t.slice(1)}` : t;
}

/** ffmpeg 滤镜参数值转义（ass= 路径中的 \ : ' [ ] , 需反斜杠转义） */
export function escapeFilterPath(p: string): string {
    return p.replace(/([\\':\[\],])/g, '\\$1');
}

class VoiceTrainService {
    /** 服务启动恢复是否已执行（把历史遗留的 running 任务标记为 failed） */
    private recoveryDone = false;

    /**
     * 懒执行一次启动恢复：HTTP 请求触发时 Mongo 已就绪。
     * cluster 下用 per-generation Redis 锁保证一次 cluster 启动只恢复一次，且只清理 updatedAt 早于阈值
     * （RECOVERY_STALE_THRESHOLD_MS）的 running 任务，避免误杀其他 worker 仍在执行的任务。
     */
    private ensureRecovery(): void {
        if (this.recoveryDone) return;
        this.recoveryDone = true;
        const staleBefore = new Date(Date.now() - RECOVERY_STALE_THRESHOLD_MS);
        void this.withRecoveryLock(async () => {
            await Promise.all([
                voiceSynthesisTaskRepository.recoverStuckRunning('服务重启中断，任务未完成', staleBefore),
                voicePipelineTaskRepository.recoverStuckRunning('服务重启中断，任务未完成', staleBefore),
            ]);
        }).catch(() => {
            this.recoveryDone = false; // 失败可重试
        });
    }

    /**
     * 一次 cluster 启动只跑一次恢复：per-generation 锁 key 兼作「本代已完成」标记。
     * worker 中途崩溃重启仍带同一代次 → 锁已存在 → 跳过，不再误标正在运行的任务。
     */
    private async withRecoveryLock(run: () => Promise<void>): Promise<void> {
        const generation = process.env.CLUSTER_GENERATION;
        if (!generation) {
            await run(); // 单进程/开发：无代次，直接执行（updatedAt 阈值兜底防误杀）
            return;
        }
        const client = RedisService.getInstance().getClient();
        const key = `${RECOVERY_LOCK_PREFIX}${generation}`;
        const acquired = await client.set(key, '1', { NX: true, EX: RECOVERY_LOCK_TTL });
        if (!acquired) return; // 本代已恢复（或正由其他 worker 恢复），本 worker 跳过
        try {
            await run();
            // 成功：保留 key 作为 done 标记（EX 30 天自动过期）
        } catch (err) {
            await client.del(key); // 失败删除以便重试
            throw err;
        }
    }

    /** 创建训练任务 */
    async createTask(dto: CreateVoiceTrainTaskDto): Promise<{ taskId: string } | { error: string }> {
        try {
            const taskId = await trainCreate(dto);
            return { taskId };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '创建训练任务失败' };
        }
    }

    /**
     * 上传音频并提交训练
     * 复用 multer 落盘后的临时文件：读入 Buffer → 调讯飞 multipart 上传 → 无论成败清理临时文件。
     */
    async submitAudio(
        file: Express.Multer.File,
        dto: SubmitAudioDto,
    ): Promise<{ data: string | null } | { error: string }> {
        let buffer: Buffer;
        try {
            buffer = fs.readFileSync(file.path);
        } catch (err) {
            return { error: err instanceof Error ? err.message : '读取音频文件失败' };
        }
        try {
            const data = await submitWithAudio({
                fileBuffer: buffer,
                fileName: file.originalname,
                mimeType: file.mimetype,
                taskId: dto.taskId,
                textId: dto.textId || XunfeiConstants.TEXTID || '',
                textSegId: dto.textSegId,
                mosRatio: dto.mosRatio,
            });
            return { data };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '提交训练失败' };
        } finally {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }
    }

    /**
     * 上传音频并自动创建训练任务：每次上传都新建一个独立讯飞训练任务（thirdUser 关联归属用户），
     * 不复用历史 taskId —— 一次上传 = 一个候选音色训练，训练完成后通过回调 /result 拿到该任务的 trainVcn。
     * 提交音频失败直接上抛，不掩盖真实错误（不隐式新建重试，避免重复建任务）。
     * 提交成功后按新 taskId 落库（trainStatus=-1 训练中），客户端以返回的 taskId 轮询 /result。
     */
    async createAndSubmitAudio(
        file: Express.Multer.File,
        dto: SubmitTrainWithAudioDto,
    ): Promise<{ data: { taskId: string } } | { error: string }> {
        let buffer: Buffer;
        try {
            buffer = fs.readFileSync(file.path);
        } catch (err) {
            return { error: err instanceof Error ? err.message : '读取音频文件失败' };
        }
        try {
            // 0) 提交前校验：该用户未删除训练记录已达上限则拒绝（不建讯飞任务、不计费、不入库）
            const userTrainCount = await voiceTrainResultRepository.countNonDeletedByUser(dto.userId);
            if (userTrainCount >= MAX_USER_TRAIN_RESULTS) {
                return { error: `音色训练数量已达上限（${MAX_USER_TRAIN_RESULTS} 条），请先清理历史训练记录` };
            }

            // 1) 每次新建讯飞训练任务（resourceName 一并上送，作为训练任务的资源名）
            const taskId = await trainCreate({ thirdUser: dto.userId, resourceName: dto.resourceName, sex: dto.sex });
            // const taskId = '123'
            // 2) 提交音频：失败直接上抛
            await submitWithAudio({
                fileBuffer: buffer,
                fileName: file.originalname,
                mimeType: file.mimetype,
                taskId,
                textId: dto.textId,
                textSegId: dto.textSegId,
                mosRatio: dto.mosRatio,
            });

            // 3) 落库：按新 taskId 写入记录（trainStatus 重置 -1，textSegId/textId 记录本次内容，resourceName 用户命名）
            try {
                await voiceTrainResultRepository.upsertByTaskId({
                    taskId,
                    userId: dto.userId,
                    trainStatus: -1, // 训练中
                    resourceName: dto.resourceName,
                    textSegId: dto.textSegId,
                    textId: dto.textId || XunfeiConstants.TEXTID,
                });
            } catch (err) {
                logger.error(`训练任务创建落库失败（taskId=${taskId}）：${err instanceof Error ? err.message : err}`);
            }
            return { data: { taskId } };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '创建训练任务并提交音频失败' };
        } finally {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }
    }

    /**
     * 查询训练结果。
     * 取到非空结果时按 taskId upsert 落库关联当前用户；DB 失败仅记日志，不影响接口返回。
     */
    async getResult(taskId: string, userId: string): Promise<{ data: XunfeiTrainResultDto | null } | { error: string }> {
        try {
            const data = await getTrainResult(taskId);
            if (data) {
                try {
                    await voiceTrainResultRepository.upsertByTaskId({ ...data, taskId, userId: userId || '' });
                } catch (err) {
                    logger.error(`训练结果落库失败（taskId=${taskId}）：${err instanceof Error ? err.message : err}`);
                }
            }
            return { data };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '获取训练结果失败' };
        }
    }

    /**
     * 处理讯飞训练完成回调：归一化 → 按 taskId upsert（不写 userId，避免覆盖创建任务时落库的归属）。
     * 失败仅记日志、不向上抛：控制器始终 ack 2xx，可依赖 /result 轮询兜底。
     */
    async handleTrainCallback(rawBody: unknown, rawQuery: Record<string, unknown>): Promise<void> {
        try {
            const data = normalizeTrainCallback({ body: rawBody, query: rawQuery });
            if (!data) {
                logger.warn('训练完成回调：未解析出 taskId，忽略本次推送')
                return;
            }
            await voiceTrainResultRepository.upsertByTaskId(data);
            logger.info(`训练完成回调落库成功（taskId=${data.taskId}）`)
        } catch (err) {
            logger.error(`训练完成回调处理失败：${err instanceof Error ? err.message : err}`)
        }
    }

    /** 分页查询当前用户的训练结果 */
    async getUserResults(
        userId: string,
        query: VoiceTrainResultQueryDto,
    ): Promise<{ data: PaginatedResponse<VoiceTrainResultItemDto> } | { error: string }> {
        try {
            if (!userId) return { error: '未登录或登录已过期' };
            const pageResult = await voiceTrainResultRepository.findUserResults(userId, query);
            return {
                data: {
                    ...pageResult,
                    list: pageResult.list.map((doc) => this.toResultItem(doc)),
                },
            };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '查询训练结果失败' };
        }
    }

    /** 分页查询公共训练记录（userId 为空/缺失的未删除记录） */
    async getPublicResults(
        query: VoiceTrainResultQueryDto,
    ): Promise<{ data: PaginatedResponse<VoiceTrainResultItemDto> } | { error: string }> {
        try {
            const pageResult = await voiceTrainResultRepository.findPublicResultsPage(query);
            return {
                data: {
                    ...pageResult,
                    list: pageResult.list.map((doc) => this.toResultItem(doc)),
                },
            };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '查询公共训练结果失败' };
        }
    }

    /** 分页查询全部训练记录（未删除，不限定 userId，含公共记录） */
    async getAllResults(
        query: VoiceTrainResultQueryDto,
    ): Promise<{ data: PaginatedResponse<VoiceTrainResultItemDto> } | { error: string }> {
        try {
            const pageResult = await voiceTrainResultRepository.findAllResults(query);
            return {
                data: {
                    ...pageResult,
                    list: pageResult.list.map((doc) => this.toResultItem(doc)),
                },
            };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '查询全部训练结果失败' };
        }
    }

    /** 修改训练结果的 resourceName（仅改展示/匹配名，不触碰音色身份与其它字段） */
    async renameResult(
        taskId: string,
        resourceName: string,
    ): Promise<{ data: VoiceTrainResultItemDto } | { error: string }> {
        try {
            const updated = await voiceTrainResultRepository.updateResourceName(taskId, resourceName);
            if (!updated) return { error: '训练记录不存在' };
            return { data: this.toResultItem(updated) };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '修改训练结果失败' };
        }
    }

    /** 训练结果落库记录 → 列表项 DTO（剔除 _id、userId 及基础字段） */
    private toResultItem(doc: VoiceTrainResultDocument): VoiceTrainResultItemDto {
        return {
            taskId: doc.taskId,
            taskName: doc.taskName,
            resourceName: doc.resourceName,
            trainVid: doc.trainVid,
            trainVcn: doc.trainVcn,
            assetId: doc.assetId,
            trainId: doc.trainId,
            appId: doc.appId,
            failedDesc: doc.failedDesc,
            sex: doc.sex,
            trainStatus: doc.trainStatus,
            ageGroup: doc.ageGroup,
            textSegId: doc.textSegId,
            textId: doc.textId,
            ...(doc.createdAt ? { createdAt: doc.createdAt.toISOString() } : {}),
            ...(doc.updatedAt ? { updatedAt: doc.updatedAt.toISOString() } : {}),
        };
    }

    async getTexts() {
        try {
            const data = await getTrainText(XunfeiConstants.TEXTID);
            return { data };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '获取训练文本失败' };
        }
    }

    /**
     * 音频合成（异步）：创建 Mongo 任务记录（pending）→ 后台 fire-and-forget 执行 → 立即返回 taskId。
     * 长文本合成耗时约 37s/千字，同步等待会阻塞 HTTP 请求，改为轮询 GET /synthesize/:taskId。
     */
    async synthesize(dto: SynthesizeAudioDto): Promise<{ data: SynthesisSubmitResult } | { error: string }> {
        try {
            this.ensureRecovery();
            const task = await voiceSynthesisTaskRepository.create({
                text: dto.text,
                resId: dto.resId,
                ...(dto.speed != null ? { speed: dto.speed } : {}),
                ...(dto.volume != null ? { volume: dto.volume } : {}),
                ...(dto.pitch != null ? { pitch: dto.pitch } : {}),
                ...(dto.language != null ? { language: dto.language } : {}),
                ...(dto.encoding ? { encoding: dto.encoding } : {}),
                ...(dto.sampleRate != null ? { sampleRate: dto.sampleRate } : {}),
                startedAt: new Date(),
            });
            const taskId = task._id.toString();
            // 后台执行，不阻塞请求；错误在 runSynthesisTask 内部捕获落库
            void this.runSynthesisTask(taskId).catch((err) => {
                logger.error(`合成任务后台执行异常：${err instanceof Error ? err.message : err}`)
            });
            return { data: { taskId, status: 'pending' } };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '提交合成任务失败' };
        }
    }

    /** 查询合成任务状态/结果 */
    async getSynthesisTask(taskId: string): Promise<{ data: SynthesisTaskResult } | { error: string }> {
        try {
            this.ensureRecovery();
            if (!isValidObjectId(taskId)) return { error: '合成任务不存在' };
            const task = await voiceSynthesisTaskRepository.findById(taskId);
            if (!task) return { error: '合成任务不存在' };
            return {
                data: {
                    taskId: task._id.toString(),
                    status: task.status,
                    ...(task.resultUrl ? { resultUrl: task.resultUrl } : {}),
                    ...(task.resultFileId ? { resultFileId: task.resultFileId } : {}),
                    ...(task.message ? { message: task.message } : {}),
                },
            };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '查询合成任务失败' };
        }
    }

    /**
     * 后台执行体：原子领取（pending→running）→ 合成落盘 → 写结果；失败标记 failed。
     */
    private async runSynthesisTask(taskId: string): Promise<void> {
        const task = await voiceSynthesisTaskRepository.findById(taskId);
        if (!task) return;

        // 仅当 status 仍为 pending 时才置为 running，防止多实例/重入重复执行
        const claimed = await voiceSynthesisTaskRepository.claimRunning(taskId);
        if (!claimed) return;

        const dto: SynthesizeAudioDto = {
            text: task.text,
            resId: task.resId,
            ...(task.speed != null ? { speed: task.speed } : {}),
            ...(task.volume != null ? { volume: task.volume } : {}),
            ...(task.pitch != null ? { pitch: task.pitch } : {}),
            ...(task.language != null ? { language: task.language } : {}),
            ...(task.encoding ? { encoding: task.encoding } : {}),
            ...(task.sampleRate != null ? { sampleRate: task.sampleRate } : {}),
        };

        try {
            const result = await this.executeSynthesis(dto);
            await voiceSynthesisTaskRepository.markSuccess(taskId, {
                resultFileId: result.fileId,
                resultUrl: result.url,
                finishedAt: new Date(),
            });
            logger.info(`合成任务 ${taskId} 完成`)
        } catch (err) {
            const message = err instanceof Error ? err.message : '音频合成失败';
            await voiceSynthesisTaskRepository.markFailed(taskId, message, new Date());
            logger.error(`合成任务 ${taskId} 失败：${message}`)
        }
    }

    /**
     * 执行合成并落盘：流式合成拿到 Buffer → 写入 file 模块上传目录 → 复用 fileService.upload 建记录。
     * 失败直接 throw，由 runSynthesisTask 捕获后标记任务 failed。
     */
    private async executeSynthesis(dto: SynthesizeAudioDto): Promise<SynthesizeResult> {
        const result = await voiceCloneSynthesis({
            text: dto.text,
            resId: dto.resId,
            ...(dto.speed != null ? { speed: dto.speed } : {}),
            ...(dto.volume != null ? { volume: dto.volume } : {}),
            ...(dto.pitch != null ? { pitch: dto.pitch } : {}),
            ...(dto.language != null ? { LanguageID: dto.language } : {}),
            ...(dto.encoding ? { encoding: dto.encoding } : {}),
            ...(dto.sampleRate != null ? { sampleRate: dto.sampleRate } : {}),
        });

        // 编码 → 扩展名 / MIME（未知编码兜底用编码名做扩展名）
        const { ext, mime } = encodingMap[result.encoding] ?? { ext: `.${result.encoding}`, mime: 'application/octet-stream' };

        // 复用 multer 的日期子目录 + UUID 命名，把合成音频作为 file 模块的上传文件落盘
        const now = new Date();
        const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
        const dir = path.join(fileConfig.uploadDir, subDir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const uuid = crypto.randomUUID();
        const storedName = `${uuid}${ext}`;
        const absolutePath = path.join(dir, storedName);
        fs.writeFileSync(absolutePath, result.audio);

        const cleanup = (): void => {
            if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
        };

        const multerFile: Express.Multer.File = {
            fieldname: 'file',
            originalname: `synthesize-${storedName}`,
            encoding: '7bit',
            mimetype: mime,
            size: result.audio.length,
            destination: dir,
            filename: storedName,
            path: absolutePath,
            buffer: result.audio,
            stream: Readable.from(result.audio),
        };

        try {
            const uploadResult = await fileService.upload(multerFile);
            return this.toFileResult(uploadResult.created);
        } catch (err) {
            cleanup();
            throw err;
        }
    }

    private toFileResult(doc: FileDocument): SynthesizeResult {
        const fileId = doc._id.toString();
        return {
            fileId,
            originalName: doc.originalName,
            mimeType: doc.mimeType,
            size: doc.size,
            url: `/api/files/${fileId}/download`,
        };
    }

    /**
     * 解析当前用户可用于视频生成的音色 resId：
     * ① 自有池优先——userId 非空时取该用户未删除训练记录，从其成功可用（trainStatus===1 且含 assetId/trainVcn）记录中
     *    按 resourceName 与 res 名称做相似度匹配，取得分 ≥ 阈值（0.6）的最高分；
     * ② 无成功可用记录或匹配分不足 → 回退公共池（userId 为空/缺失的未删除记录），同样匹配；
     * 仍未命中 → 返回错误。resId = assetId 优先，回退 trainVcn。
     */
    async resolvePipelineResId(userId?: string, res?: string): Promise<{ resId: string } | { error: string }> {
        try {
            const resName = (res ?? '').trim() || DEFAULT_VOICE_RES_NAME;
            // ① 自有池优先
            if (userId) {
                const own = await voiceTrainResultRepository.findAllNonDeletedByUser(userId);
                const hit = this.bestMatchVoiceId(own, resName);
                if (hit) return { resId: hit };
            }
            // ② 兜底公共池（含 userId 为空/无登录会话）
            const pub = await voiceTrainResultRepository.findPublicResults();
            const hit = this.bestMatchVoiceId(pub, resName);
            if (hit) return { resId: hit };
            return { error: `未找到可用的音色匹配 res=${resName}，请先完成音色训练或检查名称` };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '解析音色 resId 失败' };
        }
    }

    /**
     * 在候选训练记录中挑出与 resName 相似度 ≥ 阈值（0.6）的最高分「成功可用」记录，返回其 resId（assetId 优先，回退 trainVcn）。
     * 无命中返回 null（低于阈值的不入选；同分取更新记录——入参已按 updatedAt 倒序，先到先得）。
     */
    private bestMatchVoiceId(records: VoiceTrainResultDocument[], resName: string): string | null {
        let bestId: string | null = null;
        let bestScore = VOICE_RES_MATCH_THRESHOLD;
        for (const rec of records) {
            if (rec.trainStatus !== 1) continue;
            const id = rec.assetId || rec.trainVcn;
            if (!id) continue;
            const score = similarityScore(resName, rec.resourceName);
            if (score < bestScore) continue;
            bestScore = score;
            bestId = id;
        }
        return bestId;
    }

    /**
     * 视频生成管道（异步）：创建 Mongo 任务记录（pending）→ 后台 fire-and-forget 执行 → 立即返回 taskId。
     * 流程：合成音频 → 讯飞 raasr 转写生成 SRT → toVideo 纯色背景+音频+烧录字幕封装 mp4。
     */
    async createPipelineTask(dto: CreatePipelineTaskDto): Promise<{ data: PipelineTaskSubmitResult } | { error: string }> {
        try {
            this.ensureRecovery();
            const task = await voicePipelineTaskRepository.create({
                text: dto.text,
                resId: dto.resId,
                ...(dto.speed != null ? { speed: dto.speed } : {}),
                ...(dto.volume != null ? { volume: dto.volume } : {}),
                ...(dto.pitch != null ? { pitch: dto.pitch } : {}),
                ...(dto.language != null ? { language: dto.language } : {}),
                ...(dto.encoding ? { encoding: dto.encoding } : {}),
                ...(dto.sampleRate != null ? { sampleRate: dto.sampleRate } : {}),
                ...(dto.color ? { color: dto.color } : {}),
                ...(dto.keywords?.length ? { keywords: dto.keywords } : {}),
                ...(dto.userId ? { userId: dto.userId } : {}),
                startedAt: new Date(),
            });
            const taskId = task._id.toString();
            // 后台执行，不阻塞请求；经视频任务队列限并发执行，错误在 runPipelineTask 内部捕获落库
            void videoTaskQueue.enqueue(() => this.runPipelineTask(taskId)).catch((err) => {
                logger.error(`视频生成任务入队执行异常：${err instanceof Error ? err.message : err}`)
            });
            return { data: { taskId, status: 'pending' } };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '提交视频生成任务失败' };
        }
    }

    /**
     * 视频合成任务队列实时状态。
     * pending/running/total 取自 Mongo（status 为 pending/running 的未删除任务记录数，跨 worker 全局一致）。
     * 本地 AsyncQueue 仅作为本 worker 的并发门闩（限制并发/优雅排空），其计数不再对外暴露。
     * globalRunning 为 Redis 信号量实时占用（真正持槽的 ffmpeg 数）；与 Mongo running 允许短暂不一致：
     * 任务「先取全局槽位、后 claimRunning」，持槽但未领取时 Mongo 仍为 pending；任务 markSuccess 后、槽位 release 前同理。
     * concurrency 为全局并发上限（VIDEO_TASK_CONCURRENCY）；workerId 仅标注响应本请求的 worker（非队列归属）。
     */
    async getPipelineQueueStatus(): Promise<{ data: PipelineQueueStatusDto }> {
        const [pending, running] = await Promise.all([
            voicePipelineTaskRepository.countByStatus('pending'),
            voicePipelineTaskRepository.countByStatus('running'),
        ]);
        const total = pending + running;
        const globalRunning = await videoSemaphore.getLiveCount();
        return {
            data: {
                pending,
                running,
                total,
                concurrency: videoSemaphore.getConcurrency(),
                globalRunning,
                workerId: getWorkerId(),
            },
        };
    }

    /** 查询视频生成任务状态/结果（任务已绑定 userId 时校验归属：仅本人可查，未传 userId 的内部调用查绑定任务会被拒） */
    async getPipelineTask(taskId: string, userId?: string): Promise<{ data: PipelineTaskResult } | { error: string }> {
        try {
            this.ensureRecovery();
            if (!isValidObjectId(taskId)) return { error: '视频生成任务不存在' };
            const task = await voicePipelineTaskRepository.findById(taskId);
            if (!task) return { error: '视频生成任务不存在' };
            // 归属校验：任务已绑定用户时，仅本人可查；未绑定任务放行（MCP 等无用户上下文的内部调用创建的任务即未绑定）
            if (task.userId && task.userId !== (userId ?? '')) return { error: '无权访问该视频生成任务' };
            return {
                data: {
                    taskId: task._id.toString(),
                    status: task.status,
                    ...(task.audioUrl ? { audioUrl: task.audioUrl } : {}),
                    ...(task.audioFileId ? { audioFileId: task.audioFileId } : {}),
                    ...(task.srtUrl ? { subtitleSrtUrl: task.srtUrl } : {}),
                    ...(task.srtFileId ? { subtitleSrtFileId: task.srtFileId } : {}),
                    ...(task.assUrl ? { subtitleAssUrl: task.assUrl } : {}),
                    ...(task.assFileId ? { subtitleAssFileId: task.assFileId } : {}),
                    ...(task.videoUrl ? { videoUrl: task.videoUrl } : {}),
                    ...(task.videoFileId ? { videoFileId: task.videoFileId } : {}),
                    ...(task.message ? { message: task.message } : {}),
                },
            };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '查询视频生成任务失败' };
        }
    }

    /** 分页查询当前用户的视频生成任务 */
    async getUserPipelineTasks(
        userId: string,
        query: PipelineTaskQueryDto,
    ): Promise<{ data: PaginatedResponse<any> } | { error: string }> {
        try {
            if (!userId) return { error: '未登录或登录已过期' };
            const pageResult = await voicePipelineTaskRepository.listByUserId(userId, query);
            return {
                data: {
                    ...pageResult,
                    // list: pageResult.list.map((doc) => this.toPipelineItem(doc)),
                },
            };
        } catch (err) {
            return { error: err instanceof Error ? err.message : '查询视频生成任务列表失败' };
        }
    }

    /** 视频生成任务落库记录 → 列表项 DTO（剔除内部字段，长文截断） */
    private toPipelineItem(doc: VoicePipelineTaskDocument): PipelineTaskItemDto {
        return {
            taskId: doc._id.toString(),
            status: doc.status,
            ...(doc.text ? { text: doc.text.length > 100 ? `${doc.text.slice(0, 100)}…` : doc.text } : {}),
            ...(doc.language != null ? { language: doc.language } : {}),
            ...(doc.videoUrl ? { videoUrl: doc.videoUrl } : {}),
            ...(doc.videoFileId ? { videoFileId: doc.videoFileId } : {}),
            ...(doc.srtUrl ? { subtitleSrtUrl: doc.srtUrl } : {}),
            ...(doc.message ? { message: doc.message } : {}),
            ...(doc.createdAt ? { createdAt: doc.createdAt.toISOString() } : {}),
            ...(doc.finishedAt ? { finishedAt: doc.finishedAt.toISOString() } : {}),
        };
    }

    async raastResult(orderId: string, signatureRandom: string, resultType: string): Promise<any> {
        const res = await arrast_result(signatureRandom, orderId, resultType)
        const orderResult = (res as unknown as RaasrGetResultResponse)?.content?.orderResult
        const srt = orderResult ? parseRaasrSrt(orderResult) : ''
        // 解析出非空字幕时落盘注册为 SRT 文件，返回可下载路径；失败不影响原始结果返回
        let srtFile: SynthesizeResult | null = null
        if (srt) {
            try {
                srtFile = await this.saveSrtFile(srt)
            } catch (err) {
                logger.error(`SRT 字幕文件保存失败：${err instanceof Error ? err.message : err}`)
            }
        }
        return {
            ...res,
            srt,
            ...(srtFile ? { srtFileId: srtFile.fileId, srtUrl: srtFile.url } : {}),
        }
    }

    /** 上传合成音频到讯飞 raasr，创建转写订单；返回 orderId + 复用的 signatureRandom */
    private async uploadRaasrTranscription(
        audioAbs: string,
        fileName: string,
        mimeType: string,
    ): Promise<{ orderId: string; signatureRandom: string }> {
        const fileBuffer = fs.readFileSync(audioAbs);
        const file = new File([new Uint8Array(fileBuffer)], fileName, { type: mimeType });
        const signatureRandom = signatureRandomString();
        const orderId = await arrast_upload(file, {
            fileSize: String(fileBuffer.length),
            fileName,
            mimeType,
            signatureRandom,
        });
        if (!orderId) throw new Error('讯飞语音转写：上传未返回订单号');
        return { orderId, signatureRandom };
    }

    /** 轮询讯飞 raasr 转写结果：status 4/1 完成时解析并返回 SRT 文本；失败/超时抛错 */
    private async pollRaasrResult(orderId: string, signatureRandom: string): Promise<string> {
        let consecutiveErrors = 0;
        for (let i = 0; i < MAX_RAASR_POLL_COUNT; i++) {
            let content: RaasrGetResultResponse['content'];
            try {
                const res = await arrast_result(signatureRandom, orderId, RAASR_RESULT_TYPE);
                content = (res as unknown as RaasrGetResultResponse).content;
                consecutiveErrors = 0; // 成功响应重置连续错误计数
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('26605')) {
                    // 任务处理中，sleep 后继续轮询
                    await sleep(RAASR_POLL_INTERVAL_MS);
                    continue;
                }
                // 网络抖动 / 5s 超时等：容忍 3 次连续非处理中错误，避免偶发请求失败拖垮长轮询
                consecutiveErrors += 1;
                logger.warn(`讯飞语音转写轮询异常（第 ${i + 1}/${MAX_RAASR_POLL_COUNT} 次）：${msg}`);
                if (consecutiveErrors >= 3) throw err;
                await sleep(RAASR_POLL_INTERVAL_MS);
                continue;
            }

            const status = content?.orderInfo?.status;
            if (status === 4 || status === 1) {
                return content?.orderResult ? parseRaasrSrt(content.orderResult) : '';
            }
            if (status === -1 || status === 2) {
                const failType = content?.orderInfo?.failType;
                throw new Error(`讯飞语音转写失败：${failType != null ? failType : `订单状态 ${status}`}`);
            }
            // status 0/3：处理中
            await sleep(RAASR_POLL_INTERVAL_MS);
        }
        throw new Error('讯飞语音转写结果获取超时');
    }

    /**
     * 将 SRT 字幕内容落盘（uploads/YYYY/MM/DD 下）并注册到 file 模块，返回文件信息。
     * 复用 uploadGenerated（fake-multer），失败时清理本次落盘文件后上抛。
     */
    private async saveSrtFile(srtContent: string): Promise<SynthesizeResult> {
        const now = new Date();
        const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
        const dir = path.join(fileConfig.uploadDir, subDir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const uuid = crypto.randomUUID();
        const srtAbs = path.join(dir, `${uuid}.srt`);
        fs.writeFileSync(srtAbs, srtContent, 'utf8');

        try {
            return await this.uploadGenerated(srtAbs, `raasr-${uuid}.srt`, 'application/x-subrip');
        } catch (err) {
            if (fs.existsSync(srtAbs)) fs.unlinkSync(srtAbs);
            throw err;
        }
    }

    /**
     * 录音文件转写（raasr，同步）：读 multer 落盘音频 → 上传讯飞提交任务 → 轮询 getResult 至完成 → 直接返回转写文本。
     */
    async transcribeRaasr(dto: RaasrTranscribeDto, file: Express.Multer.File): Promise<any> {
        let fileBuffer: Buffer;
        try {
            fileBuffer = fs.readFileSync(file.path);
        } catch (err) {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            return { error: err instanceof Error ? err.message : '读取音频文件失败' };
        }

        try {
            // 1) 上传讯飞提交任务（旧 API 接收浏览器 File，需调用方生成 signatureRandom，取结果必须复用）
            const fileObj = new File([new Uint8Array(fileBuffer)], file.originalname, { type: file.mimetype });
            const signatureRandom = signatureRandomString();
            const orderId = await arrast_upload(fileObj, {
                fileSize: String(fileBuffer.length),
                fileName: file.originalname, // 真实文件名（带后缀），影响讯飞服务端转码
                mimeType: file.mimetype,
                signatureRandom,
                ...(dto.duration != null ? { duration: dto.duration } : {}),
                ...(dto.language ? { language: dto.language } : {}),
                ...(dto.roleType != null ? { roleType: dto.roleType } : {}),
                ...(dto.callbackUrl ? { callbackUrl: dto.callbackUrl } : {}),
            });
            return { orderId, signatureRandom }

        } catch (err) {
            return { error: err instanceof Error ? err.message : '录音转写失败' };
        } finally {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }
    }

    /**
     * 视频管道后台执行体：先取 Redis 全局槽位（全局限流 VIDEO_TASK_CONCURRENCY），
     * 再执行 runPipelineTaskLocked（原子领取 → 合成+字幕+封装 → 写结果）；槽位在 finally 释放。
     */
    private async runPipelineTask(taskId: string): Promise<void> {
        const task = await voicePipelineTaskRepository.findById(taskId);
        if (!task) return;

        // 先取全局槽位再 claimRunning：任务以 pending 状态排队等槽位，避免 running 干等被恢复逻辑误判
        const lease = await videoSemaphore.acquire();
        try {
            await this.runPipelineTaskLocked(taskId, task);
        } finally {
            await lease.release();
        }
    }

    /** 已持有全局槽位后的管道执行体（claimRunning → 执行 → 写结果；失败标记 failed） */
    private async runPipelineTaskLocked(taskId: string, task: VoicePipelineTaskDocument): Promise<void> {
        // 仅当 status 仍为 pending 时才置为 running，防止多实例/重入重复执行
        const claimed = await voicePipelineTaskRepository.claimRunning(taskId);
        if (!claimed) return;

        const dto: CreatePipelineTaskDto = {
            text: task.text,
            resId: task.resId,
            ...(task.speed != null ? { speed: task.speed } : {}),
            ...(task.volume != null ? { volume: task.volume } : {}),
            ...(task.pitch != null ? { pitch: task.pitch } : {}),
            ...(task.language != null ? { language: task.language } : {}),
            ...(task.encoding ? { encoding: task.encoding } : {}),
            ...(task.sampleRate != null ? { sampleRate: task.sampleRate } : {}),
            ...(task.color ? { color: task.color } : {}),
            ...(task.keywords?.length ? { keywords: task.keywords } : {}),
            ...(task.userId ? { userId: task.userId } : {}),
        };

        try {
            const result = await this.executePipeline(dto);
            await voicePipelineTaskRepository.markSuccess(taskId, {
                audioFileId: result.audio.fileId,
                audioUrl: result.audio.url,
                srtFileId: result.srt.fileId,
                srtUrl: result.srt.url,
                videoFileId: result.video.fileId,
                videoUrl: result.video.url,
                finishedAt: new Date(),
            });
            logger.info(`视频生成任务 ${taskId} 完成`)
        } catch (err) {
            const message = err instanceof Error ? err.message : '视频生成失败';
            await voicePipelineTaskRepository.markFailed(taskId, message, new Date());
            logger.error(`视频生成任务 ${taskId} 失败：${message}`)
        }
    }

    /**
     * 执行管道：合成音频 → 讯飞 raasr 转写生成 SRT → 复用 toVideo 烧录封装 mp4 → 注册 SRT。
     * 失败直接 throw，由 runPipelineTask 捕获后标记任务 failed；中间 SRT 在 finally 中清理（已注册成功的除外）。
     */
    private async executePipeline(dto: CreatePipelineTaskDto): Promise<{
        audio: SynthesizeResult;
        srt: SynthesizeResult;
        video: SynthesizeResult;
    }> {
        // 1) 复用合成：写 mp3 并注册，返回 { fileId, url, ... }
        const audio = await this.executeSynthesis(dto);
        const audioDoc = await fileService.getById(audio.fileId);
        if (!audioDoc) throw new Error('合成音频文件记录不存在');
        const audioAbs = fileService.getAbsolutePath(audioDoc);

        // uploads/YYYY/MM/DD 下生成中间 SRT
        const now = new Date();
        const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
        const dir = path.join(fileConfig.uploadDir, subDir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const uuid = crypto.randomUUID();
        const srtAbs = path.join(dir, `${uuid}.srt`);
        // 背景素材临时工作目录（dot 前缀，Express static 默认忽略 dotfiles 不暴露）
        const clipsDir = path.join(fileConfig.uploadDir, '.pipeline', uuid);
        let srtRegistered = false;

        try {
            // 2) 讯飞语音转写：上传合成音频 → 生成转写任务
            const { orderId, signatureRandom } = await this.uploadRaasrTranscription(
                audioAbs,
                audio.originalName, // synthesize-<uuid>.mp3，带真实后缀供讯飞服务端转码
                audio.mimeType,     // 默认 lame → audio/mpeg
            );
            // 3) 轮询获取转写结果，存在则解析出 SRT 文本
            const srtContent = await this.pollRaasrResult(orderId, signatureRandom);
            // 4) 转写结果存在 → 生成 SRT 文件
            if (!srtContent) throw new Error('语音转写结果为空，未生成字幕');
            fs.writeFileSync(srtAbs, srtContent, 'utf8');

            // 4.5 可选：按字幕段落构建 Pixabay 素材背景轨（无 key / 全回退 → null，走纯色）
            let backgroundPath: string | undefined;
            const cues = parseSrt(srtContent);
            if (cues.length > 0 && MaterialConstants.PIXABAY_API_KEY.trim()) {
                try {
                    fs.mkdirSync(clipsDir, { recursive: true });
                    const audioDurationMs = await probeDurationMs(audioAbs);
                    const bg = await buildBackgroundTrack({
                        cues,
                        audioDurationMs,
                        keywords: dto.keywords,
                        color: dto.color,
                        workDir: clipsDir,
                        userId: dto.userId,
                    });
                    backgroundPath = bg?.bgPath;
                } catch (err) {
                    logger.warn(`背景素材构建失败，回退纯色背景：${err instanceof Error ? err.message : err}`);
                }
            }

            // 5) 复用封装的 ffmpeg 方法：音频 + SRT 烧录 → MP4（有背景轨则作第一输入，内部注册 file 记录）
            const video = await toVideo(audioAbs, srtAbs, `pipeline-video-${uuid}.mp4`, dto.color, backgroundPath);

            // 注册 SRT（须在 toVideo 之后，避免 fileService 删掉 srtAbs）
            const srt = await this.uploadGenerated(srtAbs, `pipeline-subtitle-${uuid}.srt`, 'application/x-subrip');
            srtRegistered = true;

            return { audio, srt, video };
        } finally {
            if (!srtRegistered && fs.existsSync(srtAbs)) fs.unlinkSync(srtAbs);
            // 下载的素材 clip / 分段 / bg / list 全清（Pixabay large 5-30MB，长文本 50+ cue 峰值可达 GB 级）
            fs.rmSync(clipsDir, { recursive: true, force: true });
        }
    }

    /** 把生成的文件按 file 模块规范注册 */
    private async uploadGenerated(absolutePath: string, originalName: string, mime: string): Promise<SynthesizeResult> {
        const buf = fs.readFileSync(absolutePath);
        const multerFile: Express.Multer.File = {
            fieldname: 'file',
            originalname: originalName,
            encoding: '7bit',
            mimetype: mime,
            size: buf.length,
            destination: path.dirname(absolutePath),
            filename: path.basename(absolutePath),
            path: absolutePath,
            buffer: buf,
            stream: Readable.from(buf),
        };
        const result = await fileService.upload(multerFile);
        return this.toFileResult(result.created);
    }
}

export const voiceTrainService = new VoiceTrainService();
