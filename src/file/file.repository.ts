import FileModel, { type FileDocument } from './file.entity.ts';
import type { FileQueryDto, PaginatedResponse } from './file.dto.ts';

class FileRepository {
  /** 分页查询文件列表 */
  async findMany(query: FileQueryDto): Promise<PaginatedResponse<FileDocument>> {
    const {
      category,
      mimeType,
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
    if (mimeType) {
      filter.mimeType = { $regex: mimeType, $options: 'i' };
    }
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { originalName: { $regex: escaped, $options: 'i' } },
        { storedName: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [list, total] = await Promise.all([
      FileModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      FileModel.countDocuments(filter),
    ]);

    return { list: list as unknown as FileDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 按 ID 查找（仅未删除） */
  async findById(id: string): Promise<FileDocument | null> {
    return FileModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /** 创建文件记录 */
  async create(data: {
    originalName: string;
    storedName: string;
    path: string;
    size: number;
    mimeType: string;
    ext: string;
    md5: string;
    category?: string;
    createBy?: string;
    metadata?: Record<string, unknown>;
  }): Promise<FileDocument> {
    return FileModel.create(data);
  }

  /** 假删除（按 ID）：flag 置 0，不物理删除 */
  async softDeleteById(id: string): Promise<boolean> {
    const result = await FileModel.updateOne({ _id: id, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  /** 原子增加下载数 */
  async incrementDownloadCount(id: string): Promise<void> {
    await FileModel.findByIdAndUpdate(
      id,
      { $inc: { downloadCount: 1 } },
    ).exec();
  }

  /** 批量按 IDs 查找（仅未删除） */
  async findByIds(ids: string[]): Promise<FileDocument[]> {
    return FileModel.find({ _id: { $in: ids }, flag: 1 }).lean() as unknown as FileDocument[];
  }
}

export const fileRepository = new FileRepository();
