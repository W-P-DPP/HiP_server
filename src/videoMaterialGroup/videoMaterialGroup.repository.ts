import VideoMaterialGroupModel, { type VideoMaterialGroupDocument } from './videoMaterialGroup.entity.ts';
import type { CreateVideoMaterialGroupDto, UpdateVideoMaterialGroupDto } from './videoMaterialGroup.dto.ts';

class VideoMaterialGroupRepository {
    /** 查询指定用户的全部未删除分组（选择器一次性返回，按创建时间升序） */
    async findManyByCreateBy(createBy: string): Promise<VideoMaterialGroupDocument[]> {
        return VideoMaterialGroupModel.find({ createBy, flag: 1 })
            .sort({ createdAt: 1 })
            .lean() as unknown as VideoMaterialGroupDocument[];
    }

    /** 按 ID + 归属查询（仅未删除），用于归属校验与详情 */
    async findByIdAndCreateBy(id: string, createBy: string): Promise<VideoMaterialGroupDocument | null> {
        return VideoMaterialGroupModel.findOne({ _id: id, createBy, flag: 1 }).exec();
    }

    /** 批量按 ID 查询（仅未删除），供素材列表批量回填分组名称 */
    async findByIds(ids: string[]): Promise<VideoMaterialGroupDocument[]> {
        return VideoMaterialGroupModel.find({ _id: { $in: ids }, flag: 1 }).lean() as unknown as VideoMaterialGroupDocument[];
    }

    /** 判断同一用户下 name 是否已存在（仅未删除记录） */
    async existsByNameAndCreateBy(name: string, createBy: string): Promise<boolean> {
        const doc = await VideoMaterialGroupModel.exists({ name, createBy, flag: 1 });
        return doc !== null;
    }

    /** 判断同一用户下 name 是否已存在（排除指定 ID，用于更新时判重） */
    async existsByNameAndCreateByExcluding(name: string, createBy: string, excludeId: string): Promise<boolean> {
        const doc = await VideoMaterialGroupModel.exists({ name, createBy, flag: 1, _id: { $ne: excludeId } });
        return doc !== null;
    }

    /** 创建分组（createBy 由 BaseMongoPlugin 从请求上下文自动填充） */
    async create(dto: CreateVideoMaterialGroupDto): Promise<VideoMaterialGroupDocument> {
        return VideoMaterialGroupModel.create(dto);
    }

    /** 按 ID + 归属更新（仅未删除） */
    async updateByIdAndCreateBy(
        id: string,
        createBy: string,
        dto: UpdateVideoMaterialGroupDto,
    ): Promise<VideoMaterialGroupDocument | null> {
        return VideoMaterialGroupModel.findOneAndUpdate(
            { _id: id, createBy, flag: 1 },
            { $set: dto },
            { returnDocument: 'after', runValidators: true },
        ).exec();
    }

    /** 假删除分组（按 ID + 归属）：flag 置 0，不物理删除 */
    async softDeleteByIdAndCreateBy(id: string, createBy: string): Promise<boolean> {
        const result = await VideoMaterialGroupModel.updateOne({ _id: id, createBy, flag: 1 }, { flag: 0 }).exec();
        return (result.modifiedCount ?? 0) > 0;
    }
}

export const videoMaterialGroupRepository = new VideoMaterialGroupRepository();
