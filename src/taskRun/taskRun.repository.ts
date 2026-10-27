import TaskRunModel, { type TaskRunDocument, type TaskRunStatus } from './taskRun.entity.ts';
import type { CreateTaskRunDto, UpdateTaskRunDto, TaskRunQueryDto, PaginatedResponse } from './taskRun.dto.ts';

class TaskRunRepository {
  /** 分页查询运行记录列表 */
  async findMany(query: TaskRunQueryDto): Promise<PaginatedResponse<TaskRunDocument>> {
    const { userId, taskId, status, keyword, page = 1, limit = 20 } = query;

    const pageNum = Math.max(1, page);
    const limitNum = Math.min(100, Math.max(1, limit));

    const filter: Record<string, unknown> = { flag: 1 };

    if (userId) {
      filter.userId = userId;
    }
    if (taskId) {
      filter.taskId = taskId;
    }
    if (status) {
      filter.status = status;
    }
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { taskTitle: { $regex: escaped, $options: 'i' } },
        { message: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [list, total] = await Promise.all([
      TaskRunModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      TaskRunModel.countDocuments(filter),
    ]);

    return { list: list as unknown as TaskRunDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 按 id 查找运行记录（仅未删除） */
  async findById(id: string): Promise<TaskRunDocument | null> {
    return TaskRunModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /** 创建运行记录 */
  async create(dto: CreateTaskRunDto): Promise<TaskRunDocument> {
    return TaskRunModel.create(dto);
  }

  /** 更新运行记录（按 id） */
  async updateById(id: string, dto: UpdateTaskRunDto): Promise<TaskRunDocument | null> {
    return TaskRunModel.findByIdAndUpdate(
      id,
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 假删除运行记录（按 id）：flag 置 0，不物理删除 */
  async softDeleteById(id: string): Promise<boolean> {
    const result = await TaskRunModel.updateOne({ _id: id, flag: 1 }, { flag: 0 }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }
}

export const taskRunRepository = new TaskRunRepository();
