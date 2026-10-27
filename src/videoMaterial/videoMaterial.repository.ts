import VideoMaterialModel, { type VideoMaterialDocument } from './videoMaterial.entity.ts';
import type { VideoMaterialQueryDto, PaginatedResponse } from './videoMaterial.dto.ts';

class VideoMaterialRepository {
    /** 查询全部未删除素材（供相似度扫描） */
    async findAll(): Promise<VideoMaterialDocument[]> {
        return VideoMaterialModel.find({ flag: 1 }).lean() as unknown as VideoMaterialDocument[];
    }

    /** 查询指定 createBy 的全部未删除素材（'' 公共 / userId 个人），供相似度扫描 */
    async findAllByCreateBy(createBy: string): Promise<VideoMaterialDocument[]> {
        return VideoMaterialModel.find({ flag: 1, createBy }).lean() as unknown as VideoMaterialDocument[];
    }

    /** 按 keyword 精确查找（仅未删除） */
    async findByKeyword(keyword: string): Promise<VideoMaterialDocument | null> {
        return VideoMaterialModel.findOne({ keyword, flag: 1 }).exec();
    }

    /** 判断 keyword 是否已存在（仅未删除记录） */
    async existsByKeyword(keyword: string): Promise<boolean> {
        const doc = await VideoMaterialModel.exists({ keyword, flag: 1 });
        return doc !== null;
    }

    /** 判断 keyword 是否已存在（仅未删除，排除指定 ID，用于更新时判重） */
    async existsByKeywordExcluding(keyword: string, excludeId: string): Promise<boolean> {
        const doc = await VideoMaterialModel.exists({ keyword, flag: 1, _id: { $ne: excludeId } });
        return doc !== null;
    }

    /** 按 ID 查找（仅未删除） */
    async findById(id: string): Promise<VideoMaterialDocument | null> {
        return VideoMaterialModel.findOne({ _id: id, flag: 1 }).exec();
    }

    /** 分页查询素材列表 */
    async findMany(query: VideoMaterialQueryDto): Promise<PaginatedResponse<VideoMaterialDocument>> {
        const { keyword, createBy, groupId, page = 1, limit = 20 } = query;

        const pageNum = Math.max(1, page);
        const limitNum = Math.min(100, Math.max(1, limit));

        const filter: Record<string, unknown> = { flag: 1 };
        if (keyword) {
            // 同时模糊匹配 keyword 与 fileName 字段（搜索框按关键字搜索）
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = { $regex: escaped, $options: 'i' };
            filter.$or = [{ keyword: regex }, { fileName: regex }];
        }
        // createBy 过滤（'' 表示公共素材；createBy 字段 select:false 但查询过滤不受影响）
        if (createBy !== undefined) {
            filter.createBy = createBy;
        }
        // groupId 过滤（'' 表示未分组；不传则不过滤）
        if (groupId !== undefined) {
            filter.groupId = groupId;
        }

        const [list, total] = await Promise.all([
            VideoMaterialModel.find(filter)
                .sort({ createdAt: -1 })
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .lean(),
            VideoMaterialModel.countDocuments(filter),
        ]);

        return { list: list as unknown as VideoMaterialDocument[], total, page: pageNum, limit: limitNum };
    }

    /** 按 ID 更新（仅未删除） */
    async updateById(id: string, dto: Record<string, unknown>): Promise<VideoMaterialDocument | null> {
        return VideoMaterialModel.findOneAndUpdate(
            { _id: id, flag: 1 },
            { $set: dto },
            { returnDocument: 'after', runValidators: true },
        ).exec();
    }

    /** 创建素材映射记录（keyword 唯一性由应用层判重保证，数据库不建唯一索引） */
    async create(data: {
        keyword: string;
        fileId: string;
        fileName: string;
        groupId?: string;
        createBy?: string;
    }): Promise<VideoMaterialDocument> {
        return VideoMaterialModel.create(data);
    }

    /** 解绑分组：把指定分组下的未删除素材 groupId 置空（删除分组时级联调用） */
    async clearGroupIdByGroupId(groupId: string): Promise<number> {
        const result = await VideoMaterialModel.updateMany({ groupId, flag: 1 }, { $set: { groupId: '' } }).exec();
        return result.modifiedCount ?? 0;
    }

    /** 批量分组：把当前用户的指定素材统一归入 groupId（'' 表示移出分组），返回实际改动条数 */
    async updateGroupIdByIds(ids: string[], groupId: string, createBy: string): Promise<number> {
        const result = await VideoMaterialModel.updateMany(
            { _id: { $in: ids }, createBy, flag: 1 },
            { $set: { groupId } },
        ).exec();
        return result.modifiedCount ?? 0;
    }

    /** 增加复用命中次数（仅未删除记录，避免软删后误计数） */
    async incrementHitCount(id: string): Promise<void> {
        await VideoMaterialModel.findOneAndUpdate(
            { _id: id, flag: 1 },
            { $inc: { hitCount: 1 } },
        ).exec();
    }

    /** 假删除（按 ID）：flag 置 0，不物理删除 */
    async softDeleteById(id: string): Promise<boolean> {
        const result = await VideoMaterialModel.updateOne({ _id: id, flag: 1 }, { flag: 0 }).exec();
        return (result.modifiedCount ?? 0) > 0;
    }
}

export const videoMaterialRepository = new VideoMaterialRepository();
