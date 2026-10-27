import SkillModel, { type SkillDocument, type SkillStatus } from './skill.entity.ts';
import type { CreateSkillDto, UpdateSkillDto, SkillQueryDto, PaginatedResponse } from './skill.dto.ts';

class SkillRepository {
  /** 分页查询 Skill 列表 */
  async findMany(query: SkillQueryDto): Promise<PaginatedResponse<SkillDocument>> {
    const {
      category,
      tags,
      status,
      keyword,
      page = 1,
      limit = 20,
    } = query;

    const pageNum = Math.max(1, page);
    const limitNum = Math.min(100, Math.max(1, limit));

    const filter: Record<string, unknown> = { flag: 1 };

    if (category) {
      filter.category = category;
    }
    if (tags) {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
      if (tagList.length > 0) {
        filter.tags = { $in: tagList };
      }
    }
    if (status) {
      filter.status = status;
    }
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { key: { $regex: escaped, $options: 'i' } },
        { name: { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [list, total] = await Promise.all([
      SkillModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      SkillModel.countDocuments(filter),
    ]);

    return { list: list as unknown as SkillDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 按 key 查找（仅未删除） */
  async findByKey(key: string): Promise<SkillDocument | null> {
    return SkillModel.findOne({ key, flag: 1 }).exec();
  }

  /** 判断 key 是否已存在（仅未删除） */
  async existsByKey(key: string): Promise<boolean> {
    const doc = await SkillModel.exists({ key, flag: 1 });
    return doc !== null;
  }

  /** 创建 Skill */
  async create(dto: CreateSkillDto): Promise<SkillDocument> {
    return SkillModel.create(dto);
  }

  /** 更新 Skill（按 key） */
  async updateByKey(key: string, dto: UpdateSkillDto): Promise<SkillDocument | null> {
    return SkillModel.findOneAndUpdate(
      { key },
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 假删除 Skill（按 key）：flag 置 0，不物理删除 */
  async softDeleteByKey(key: string): Promise<boolean> {
    const result = await SkillModel.updateOne({ key, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  /** 恢复已假删除的 Skill（按 key，flag 置回 1） */
  async restoreByKey(key: string, dto: CreateSkillDto): Promise<SkillDocument | null> {
    return SkillModel.findOneAndUpdate(
      { key, flag: 0 },
      { $set: { ...dto, flag: 1 } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 原子增加下载数 */
  async incrementDownloadCount(key: string): Promise<void> {
    await SkillModel.findOneAndUpdate(
      { key },
      { $inc: { downloadCount: 1 } },
    ).exec();
  }

  /** 原子减少下载数（不低于 0） */
  async decrementDownloadCount(key: string): Promise<void> {
    await SkillModel.findOneAndUpdate(
      { key, downloadCount: { $gt: 0 } },
      { $inc: { downloadCount: -1 } },
    ).exec();
  }

  /** 批量按 keys 查找（仅未删除） */
  async findByKeys(keys: string[]): Promise<SkillDocument[]> {
    return SkillModel.find({ key: { $in: keys }, flag: 1 }).lean() as unknown as SkillDocument[];
  }
}

export const skillRepository = new SkillRepository();
