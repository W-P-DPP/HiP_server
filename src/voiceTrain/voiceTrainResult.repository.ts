import VoiceTrainResultModel, { type VoiceTrainResultDocument } from './voiceTrainResult.entity.ts';
import type { XunfeiTrainResultDto } from '../../utils/xunfei/xunfei.d.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';

/** 落库入参：Xunfei 训练结果 DTO（部分字段，缺省字段插入时取 schema 默认值）+ 查询用 taskId + 归属用户 */
export interface SaveVoiceTrainResultData extends Partial<XunfeiTrainResultDto> {
    /** 讯飞训练任务 id（upsert 唯一键） */
    taskId: string;
    /** 归属用户 id（可选；空/缺省时保持既有 userId 不变，回调推送不携带 userId） */
    userId?: string;
    /** 训练得到的音色标识（回调推送 trainVcn，可复用为下游合成 resId） */
    trainVcn?: string;
    /** 训练文本段落 ID */
    textSegId?: string;
    /** 文本 ID */
    textId?: string;
}

class VoiceTrainResultRepository {
    /**
     * 按 taskId upsert：轮询每次取到非空结果都更新或插入，
     * 始终反映最新状态（含失败/处理中），且不会产生重复记录。
     * userId 由用户上传，每次直接 $set 写入，保证上传值权威生效；
     * resourceName 为用户的展示/匹配名，只在插入时写入（$setOnInsert）——
     * 训练完成回调/轮询携带的讯飞 resourceName 不覆盖提交时用户命名，改名走 updateResourceName。
     */
    async upsertByTaskId(data: SaveVoiceTrainResultData): Promise<VoiceTrainResultDocument> {
        const { taskId, userId, resourceName, ...rest } = data;
        const $set: Record<string, unknown> = { ...rest };
        // 空/缺省 userId 不覆盖既有归属用户（回调推送不带 userId，避免抹掉创建任务时落库的 userId）
        if (userId !== undefined && userId !== '') $set.userId = userId;
        // 过滤 undefined，防止 Mongoose $set: {a: undefined} 抹除字段
        for (const key of Object.keys($set)) {
            if ($set[key] === undefined) delete $set[key];
        }

        const update: Record<string, unknown> = { $set };
        // 提交时落库（submit 是每条记录的首插）写入用户命名；后续回调/轮询不覆盖
        if (resourceName !== undefined && resourceName !== '') {
            update.$setOnInsert = { resourceName };
        }

        return VoiceTrainResultModel.findOneAndUpdate(
            { taskId },
            update,
            { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
        ).exec();
    }

    /** 仅更新某训练记录的 resourceName（不存在或已删除返回 null；不带 upsert，避免误建新记录） */
    async updateResourceName(taskId: string, resourceName: string): Promise<VoiceTrainResultDocument | null> {
        return VoiceTrainResultModel.findOneAndUpdate(
            { taskId, flag: 1 },
            { $set: { resourceName } },
            { returnDocument: 'after', runValidators: true },
        ).exec();
    }

    /** 统计某用户未删除训练记录数（userId 精确匹配 + flag=1） */
    async countNonDeletedByUser(userId: string): Promise<number> {
        return VoiceTrainResultModel.countDocuments({ userId, flag: 1 });
    }

    /** 分页查询当前用户的训练结果（按更新时间倒序，仅未删除） */
    async findUserResults(
        userId: string,
        query: { page?: number; limit?: number },
    ): Promise<PaginatedResponse<VoiceTrainResultDocument>> {
        return this.paginate({ userId }, query);
    }

    /** 通用分页查询（未删除记录，按更新时间倒序） */
    private async paginate(
        filter: Record<string, unknown>,
        query: { page?: number; limit?: number },
    ): Promise<PaginatedResponse<VoiceTrainResultDocument>> {
        const { page = 1, limit = 20 } = query;
        const pageNum = Math.max(1, page);
        const limitNum = Math.min(100, Math.max(1, limit));

        const combined: Record<string, unknown> = { flag: 1, ...filter };

        const [list, total] = await Promise.all([
            VoiceTrainResultModel.find(combined)
                .sort({ updatedAt: -1 })
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .lean(),
            VoiceTrainResultModel.countDocuments(combined),
        ]);

        return { list: list as unknown as VoiceTrainResultDocument[], total, page: pageNum, limit: limitNum };
    }

    /** 分页查询全部训练记录（未删除，不限定 userId，含公共记录） */
    async findAllResults(query: { page?: number; limit?: number }): Promise<PaginatedResponse<VoiceTrainResultDocument>> {
        return this.paginate({}, query);
    }

    /** 分页查询公共训练记录池（未删除且 userId 为空/缺失），供 HTTP 列表展示 */
    async findPublicResultsPage(query: { page?: number; limit?: number }): Promise<PaginatedResponse<VoiceTrainResultDocument>> {
        return this.paginate({ userId: { $in: [null, ''] } }, query);
    }

    /** 某用户全部未删除训练记录（音色名称匹配候选，按更新时间倒序） */
    async findAllNonDeletedByUser(userId: string): Promise<VoiceTrainResultDocument[]> {
        return VoiceTrainResultModel.find({ userId, flag: 1 })
            .sort({ updatedAt: -1 })
            .lean() as unknown as VoiceTrainResultDocument[];
    }

    /** 公共训练记录池：未删除且 userId 为空/缺失（null / '' / 字段不存在），供无自有训练记录的用户兜底 */
    async findPublicResults(): Promise<VoiceTrainResultDocument[]> {
        return VoiceTrainResultModel.find({ flag: 1, userId: { $in: [null, ''] } })
            .sort({ updatedAt: -1 })
            .lean() as unknown as VoiceTrainResultDocument[];
    }
}

export const voiceTrainResultRepository = new VoiceTrainResultRepository();
