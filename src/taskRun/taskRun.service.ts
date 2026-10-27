import { taskRunRepository } from './taskRun.repository.ts';
import type { CreateTaskRunDto, UpdateTaskRunDto, TaskRunQueryDto } from './taskRun.dto.ts';
import type { TaskRunDocument } from './taskRun.entity.ts';

class TaskRunService {
  /** 获取运行记录分页列表 */
  async list(query: TaskRunQueryDto) {
    return taskRunRepository.findMany(query);
  }

  /** 获取单个运行记录 */
  async getById(id: string): Promise<TaskRunDocument | null> {
    return taskRunRepository.findById(id);
  }

  /** 创建运行记录 */
  async create(dto: CreateTaskRunDto): Promise<{ created: TaskRunDocument } | { error: string }> {
    const created = await taskRunRepository.create(dto);
    return { created };
  }

  /** 更新运行记录 */
  async update(id: string, dto: UpdateTaskRunDto): Promise<{ updated: TaskRunDocument } | { error: string }> {
    const updated = await taskRunRepository.updateById(id, dto);
    if (!updated) {
      return { error: '运行记录不存在' };
    }
    return { updated };
  }

  /** 删除运行记录（假删除） */
  async delete(id: string): Promise<{ error?: string }> {
    const deleted = await taskRunRepository.softDeleteById(id);
    if (!deleted) {
      return { error: '运行记录不存在' };
    }
    return {};
  }
}

export const taskRunService = new TaskRunService();
