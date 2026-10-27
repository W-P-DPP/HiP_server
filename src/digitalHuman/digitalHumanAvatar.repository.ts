import DigitalHumanAvatarModel, {
  type DigitalHumanAvatarDocument,
} from './digitalHumanAvatar.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';

/** 判断是否为 MongoDB 唯一索引冲突（E11000）；并发下预检通过后仍可能撞索引，需据此回 409 而非 500 */
export { isDuplicateKeyError } from '../voiceTrainV2/voiceTrainV2Voice.repository.ts';

/** 落库入参：上传参考视频并创建形象时的记录字段 */
export interface CreateDigitalHumanAvatarData {
  /** 形象名称（调用方已 trim 校验） */
  name: string;
  /** 上传素材的原始文件名 */
  sourceOriginalName: string;
  /** 上传素材大小（字节） */
  sourceSize: number;
  /** 上传素材 MIME 类型 */
  sourceMimeType: string;
  /** 上传素材时长（秒），调用方已保证在 5–45 之间 */
  sourceDuration: number;
  /** 归一化参考视频的 file 记录 id */
  referenceFileId: string;
  /** 参考视频相对 uploadDir 路径 */
  referencePath: string;
  /** 归一化参考视频时长（秒） */
  referenceDuration: number;
  backend?: string;
  userId?: string;
}

/** 查询入参：userId 精确匹配、name 模糊匹配（均为可选），分页 page/limit */
export interface QueryDigitalHumanAvatarData {
  userId?: string;
  name?: string;
  page?: number;
  limit?: number;
}

class DigitalHumanAvatarRepository {
  /** 新增一条形象记录 */
  async create(data: CreateDigitalHumanAvatarData): Promise<DigitalHumanAvatarDocument> {
    return DigitalHumanAvatarModel.create({
      ...data,
      userId: data.userId ?? '',
    });
  }

  /** 按主键查询单个记录（仅未删除） */
  async findById(id: string): Promise<DigitalHumanAvatarDocument | null> {
    return DigitalHumanAvatarModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /**
   * 该用户未删除记录中是否已存在同名形象（名称唯一性预检）。
   * 精确匹配（大小写敏感），与 { userId, name } 唯一索引的口径保持一致。
   */
  async existsByUserAndName(userId: string, name: string): Promise<boolean> {
    const count = await DigitalHumanAvatarModel.countDocuments({ userId, name, flag: 1 });
    return count > 0;
  }

  /**
   * 按归属用户 + 名称精确查询单个未删除形象。
   * 精确匹配（大小写敏感），与 { userId, name } 唯一索引的口径保持一致。
   */
  async findByUserAndName(userId: string, name: string): Promise<DigitalHumanAvatarDocument | null> {
    return DigitalHumanAvatarModel.findOne({ userId, name, flag: 1 }).exec();
  }

  /** 分页查询：userId 精确 + name 模糊（不传则不限制该维度），按创建时间倒序，仅未删除 */
  async findPage(query: QueryDigitalHumanAvatarData): Promise<PaginatedResponse<DigitalHumanAvatarDocument>> {
    const filter: Record<string, unknown> = {};
    if (query.userId) filter.userId = query.userId;
    if (query.name) {
      filter.name = { $regex: DigitalHumanAvatarRepository.escapeRegex(query.name), $options: 'i' };
    }
    return this.paginate(filter, query);
  }

  /** 按主键 + 归属用户改名（非本人记录返回 null，不带 upsert 避免误建新记录） */
  async updateNameByOwner(
    id: string,
    userId: string,
    name: string,
  ): Promise<DigitalHumanAvatarDocument | null> {
    return DigitalHumanAvatarModel.findOneAndUpdate(
      { _id: id, userId, flag: 1 },
      { $set: { name } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 按主键 + 归属用户假删除（flag 置 0，磁盘文件与 file 记录保留）；返回是否命中并修改 */
  async softDeleteByOwner(id: string, userId: string): Promise<boolean> {
    const res = await DigitalHumanAvatarModel.updateOne({ _id: id, userId, flag: 1 }, { flag: 0 }).exec();
    return res.modifiedCount > 0;
  }

  /** 通用分页查询（未删除记录，按创建时间倒序） */
  private async paginate(
    filter: Record<string, unknown>,
    query: { page?: number; limit?: number },
  ): Promise<PaginatedResponse<DigitalHumanAvatarDocument>> {
    const { page, limit } = query;
    // Number.isFinite 兜底：?page=abc 会解析成 NaN，直接传给 skip/limit 会抛错
    const pageNum = Number.isFinite(page) ? Math.max(1, Math.floor(page as number)) : 1;
    const limitNum = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit as number))) : 20;

    const combined: Record<string, unknown> = { flag: 1, ...filter };

    const [list, total] = await Promise.all([
      DigitalHumanAvatarModel.find(combined)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      DigitalHumanAvatarModel.countDocuments(combined),
    ]);

    return { list: list as unknown as DigitalHumanAvatarDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 转义正则元字符，避免 name 作为正则表达式被解析 */
  private static escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export const digitalHumanAvatarRepository = new DigitalHumanAvatarRepository();
