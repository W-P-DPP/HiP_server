import ScheduledTaskModel, { type ScheduledTaskDocument, type ScheduledTaskStatus } from './scheduledTask.entity.ts';
import type { CreateScheduledTaskDto, UpdateScheduledTaskDto, ScheduledTaskQueryDto, RunRecordQueryDto, PaginatedResponse } from './scheduledTask.dto.ts';

class ScheduledTaskRepository {
  /** 分页查询定时任务列表 */
  async findMany(query: ScheduledTaskQueryDto): Promise<PaginatedResponse<ScheduledTaskDocument>> {
    const { userId, status, keyword, page = 1, limit = 20 } = query;

    const pageNum = Math.max(1, page);
    const limitNum = Math.min(100, Math.max(1, limit));

    const filter: Record<string, unknown> = { flag: 1 };

    if (userId) {
      filter.userId = userId;
    }
    if (status) {
      filter.status = status;
    }
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { title: { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [list, total] = await Promise.all([
      ScheduledTaskModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      ScheduledTaskModel.countDocuments(filter),
    ]);

    return { list: list as unknown as ScheduledTaskDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 按 id 查找（仅未删除） */
  async findById(id: string): Promise<ScheduledTaskDocument | null> {
    return ScheduledTaskModel.findOne({
      _id: id,
      flag: 1,
    }).exec();
  }

  /** 分页查询用户的运行记录（状态为成功或失败） */
  async findRunRecords(query: RunRecordQueryDto): Promise<PaginatedResponse<ScheduledTaskDocument>> {
    const { userId, page = 1, limit = 20 } = query;

    const pageNum = Math.max(1, page);
    const limitNum = Math.min(100, Math.max(1, limit));

    const filter: Record<string, unknown> = {
      userId,
      status: { $in: ['success', 'failed'] as ScheduledTaskStatus[] },
      flag: 1,
    };

    const [list, total] = await Promise.all([
      ScheduledTaskModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      ScheduledTaskModel.countDocuments(filter),
    ]);

    return { list: list as unknown as ScheduledTaskDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 创建定时任务 */
  async create(dto: CreateScheduledTaskDto): Promise<ScheduledTaskDocument> {
    return ScheduledTaskModel.create(dto);
  }

  /** 更新定时任务（按 id） */
  async updateById(id: string, dto: UpdateScheduledTaskDto): Promise<ScheduledTaskDocument | null> {
    return ScheduledTaskModel.findByIdAndUpdate(
      id,
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 假删除定时任务（按 id）：flag 置 0，不物理删除 */
  async softDeleteById(id: string): Promise<boolean> {
    const result = await ScheduledTaskModel.updateOne({ _id: id, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  /** 批量假删除定时任务 */
  async softDeleteByIds(ids: string[]): Promise<number> {
    const result = await ScheduledTaskModel.updateMany(
      { _id: { $in: ids }, flag: 1 },
      { flag: 0 },
    ).exec();
    return result.modifiedCount ?? 0;
  }
}

export const scheduledTaskRepository = new ScheduledTaskRepository();
