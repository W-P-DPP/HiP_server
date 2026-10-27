import { Types } from 'mongoose';
import { videoMaterialGroupRepository } from './videoMaterialGroup.repository.ts';
import type { CreateVideoMaterialGroupDto, UpdateVideoMaterialGroupDto } from './videoMaterialGroup.dto.ts';
import type { VideoMaterialGroupDocument } from './videoMaterialGroup.entity.ts';
import { videoMaterialRepository } from '../videoMaterial/videoMaterial.repository.ts';
import { getCurrentUserId } from '../../utils/requestContext.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** 业务结果：成功返回 data，失败返回 error + HTTP 状态码 */
type ServiceResult<T> = { data: T } | { error: string; code: number };

class VideoMaterialGroupService {
    /** 当前请求的归属用户（未登录时落公共桶 ''，与个人素材的 createBy 口径一致） */
    private owner(): string {
        return getCurrentUserId() ?? '';
    }

    /** 创建分组：name 必填、同一用户下不重名 */
    async create(dto: CreateVideoMaterialGroupDto): Promise<ServiceResult<VideoMaterialGroupDocument>> {
        const name = dto.name?.trim();
        if (!name) {
            return { error: 'name 为必填字段', code: HttpStatus.BAD_REQUEST };
        }

        const owner = this.owner();
        if (await videoMaterialGroupRepository.existsByNameAndCreateBy(name, owner)) {
            return { error: '同名分组已存在', code: HttpStatus.CONFLICT };
        }

        const created = await videoMaterialGroupRepository.create({ name });
        return { data: created };
    }

    /** 当前用户的全部未删除分组 */
    async list(): Promise<{ list: VideoMaterialGroupDocument[] }> {
        return { list: await videoMaterialGroupRepository.findManyByCreateBy(this.owner()) };
    }

    /** 更新分组名称：同一用户下不重名 */
    async update(id: string, dto: UpdateVideoMaterialGroupDto): Promise<ServiceResult<VideoMaterialGroupDocument>> {
        const owner = this.owner();
        const existing = await videoMaterialGroupRepository.findByIdAndCreateBy(id, owner);
        if (!existing) {
            return { error: '分组不存在', code: HttpStatus.NOT_FOUND };
        }

        const patch: UpdateVideoMaterialGroupDto = {};
        if (dto.name !== undefined) {
            const name = dto.name.trim();
            if (!name) {
                return { error: 'name 不能为空', code: HttpStatus.BAD_REQUEST };
            }
            if (name !== existing.name && (await videoMaterialGroupRepository.existsByNameAndCreateByExcluding(name, owner, id))) {
                return { error: '同名分组已存在', code: HttpStatus.CONFLICT };
            }
            patch.name = name;
        }

        if (Object.keys(patch).length === 0) {
            return { data: existing };
        }

        const updated = await videoMaterialGroupRepository.updateByIdAndCreateBy(id, owner, patch);
        if (!updated) {
            return { error: '分组不存在', code: HttpStatus.NOT_FOUND };
        }
        return { data: updated };
    }

    /** 删除分组：软删分组，并把其下素材的 groupId 置空（素材保留） */
    async delete(id: string): Promise<{ data: true } | { error: string; code: number }> {
        if (!Types.ObjectId.isValid(id)) {
            return { error: '非法的 id 参数', code: HttpStatus.BAD_REQUEST };
        }

        const ok = await videoMaterialGroupRepository.softDeleteByIdAndCreateBy(id, this.owner());
        if (!ok) {
            return { error: '分组不存在', code: HttpStatus.NOT_FOUND };
        }

        await videoMaterialRepository.clearGroupIdByGroupId(id);
        return { data: true };
    }
}

export const videoMaterialGroupService = new VideoMaterialGroupService();
