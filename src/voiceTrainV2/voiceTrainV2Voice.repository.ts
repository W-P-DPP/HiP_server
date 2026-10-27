import VoiceTrainV2VoiceModel, { type VoiceTrainV2VoiceDocument } from './voiceTrainV2Voice.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';

/** 判断是否为 MongoDB 唯一索引冲突（E11000）；并发下预检通过与插入之间仍可能撞索引，需据此回 409 而非 500 */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** 落库入参：上传音频并创建音色时的记录字段 */
export interface CreateVoiceTrainV2VoiceData {
  /** 音色名称（调用方已 trim 校验） */
  resourceName: string;
  /** 上传素材的原始文件名 */
  sourceOriginalName: string;
  /** 上传素材大小（字节） */
  sourceSize: number;
  /** 上传素材 MIME 类型 */
  sourceMimeType: string;
  /** 上传素材时长（秒），调用方已保证 >= 10 */
  sourceDuration: number;
  /** 归一化 reference.wav 的 file 记录 id */
  referenceFileId: string;
  /** reference.wav 相对 uploadDir 路径 */
  referencePath: string;
  /** reference.wav 时长（秒） */
  referenceDuration: number;
  promptText?: string;
  backend?: string;
  sampleRate?: number;
  userId?: string;
}

/** 查询入参：userId 精确匹配、resourceName 模糊匹配（均为可选），分页 page/limit */
export interface QueryVoiceTrainV2VoiceData {
  userId?: string;
  resourceName?: string;
  page?: number;
  limit?: number;
}

class VoiceTrainV2VoiceRepository {
  /** 新增一条音色记录 */
  async create(data: CreateVoiceTrainV2VoiceData): Promise<VoiceTrainV2VoiceDocument> {
    return VoiceTrainV2VoiceModel.create({
      ...data,
      userId: data.userId ?? '',
    });
  }

  /** 按主键查询单个记录（仅未删除） */
  async findById(id: string): Promise<VoiceTrainV2VoiceDocument | null> {
    return VoiceTrainV2VoiceModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /**
   * 该用户未删除记录中是否已存在同名音色（名称唯一性预检）。
   * 精确匹配（大小写敏感），与 { userId, resourceName } 唯一索引的判定口径保持一致 ——
   * 若此处放宽为大小写不敏感，会出现预检通过但插入撞索引的情况。
   */
  async existsByUserAndName(userId: string, resourceName: string): Promise<boolean> {
    const count = await VoiceTrainV2VoiceModel.countDocuments({ userId, resourceName, flag: 1 });
    return count > 0;
  }

  /**
   * 按归属用户 + 名称精确查询单个未删除音色。
   * 精确匹配（大小写敏感），与 { userId, resourceName } 唯一索引的口径保持一致。
   */
  async findByUserAndName(userId: string, resourceName: string): Promise<VoiceTrainV2VoiceDocument | null> {
    return VoiceTrainV2VoiceModel.findOne({ userId, resourceName, flag: 1 }).exec();
  }

  /** 分页查询：userId 精确 + resourceName 模糊（不传则不限制该维度），按创建时间倒序，仅未删除 */
  async findPage(query: QueryVoiceTrainV2VoiceData): Promise<PaginatedResponse<VoiceTrainV2VoiceDocument>> {
    const filter: Record<string, unknown> = {};
    if (query.userId) filter.userId = query.userId;
    if (query.resourceName) {
      filter.resourceName = { $regex: VoiceTrainV2VoiceRepository.escapeRegex(query.resourceName), $options: 'i' };
    }
    return this.paginate(filter, query);
  }

  /** 按主键 + 归属用户改名（非本人记录返回 null，不带 upsert 避免误建新记录） */
  async updateNameByOwner(
    id: string,
    userId: string,
    resourceName: string,
  ): Promise<VoiceTrainV2VoiceDocument | null> {
    return VoiceTrainV2VoiceModel.findOneAndUpdate(
      { _id: id, userId, flag: 1 },
      { $set: { resourceName } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 合成成功后回写试听信息（仅未删除记录）。
   *
   * 带 `previewAt` 新旧条件：时间更早的成功结果不得覆盖更新的试听。当前 dispatcher 由 leader
   * 租约 + busy 标志串行执行，完成顺序即提交顺序，此条件通常不触发；它是廉价的不变式校验，
   * 避免日后调度改并发后出现「旧结果盖新结果」。返回是否命中并修改。
   */
  async updatePreview(
    id: string,
    data: {
      previewFileId: string;
      previewUrl: string;
      previewText: string;
      previewDuration: number;
      previewAt: Date;
    },
  ): Promise<boolean> {
    const res = await VoiceTrainV2VoiceModel.updateOne(
      { _id: id, flag: 1, $or: [{ previewAt: null }, { previewAt: { $lt: data.previewAt } }] },
      { $set: data },
    ).exec();
    return res.modifiedCount > 0;
  }

  /** 按主键 + 归属用户假删除（flag 置 0，磁盘文件与 file 记录保留）；返回是否命中并修改 */
  async softDeleteByOwner(id: string, userId: string): Promise<boolean> {
    const res = await VoiceTrainV2VoiceModel.updateOne({ _id: id, userId, flag: 1 }, { flag: 0 }).exec();
    return res.modifiedCount > 0;
  }

  /** 通用分页查询（未删除记录，按创建时间倒序） */
  private async paginate(
    filter: Record<string, unknown>,
    query: { page?: number; limit?: number },
  ): Promise<PaginatedResponse<VoiceTrainV2VoiceDocument>> {
    const { page, limit } = query;
    // Number.isFinite 兜底：?page=abc 会解析成 NaN，直接传给 skip/limit 会抛错
    const pageNum = Number.isFinite(page) ? Math.max(1, Math.floor(page as number)) : 1;
    const limitNum = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit as number))) : 20;

    const combined: Record<string, unknown> = { flag: 1, ...filter };

    const [list, total] = await Promise.all([
      VoiceTrainV2VoiceModel.find(combined)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      VoiceTrainV2VoiceModel.countDocuments(combined),
    ]);

    return { list: list as unknown as VoiceTrainV2VoiceDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 转义正则元字符，避免 name 作为正则表达式被解析 */
  private static escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export const voiceTrainV2VoiceRepository = new VoiceTrainV2VoiceRepository();
