import { scheduledTaskRepository } from './scheduledTask.repository.ts';
import type { CreateScheduledTaskDto, UpdateScheduledTaskDto, ScheduledTaskQueryDto, RunRecordQueryDto } from './scheduledTask.dto.ts';
import type { ScheduledTaskDocument } from './scheduledTask.entity.ts';

class ScheduledTaskService {
  /** 获取定时任务分页列表 */
  async list(query: ScheduledTaskQueryDto) {
    return scheduledTaskRepository.findMany(query);
  }

  /** 获取单个定时任务 */
  async getById(id: string): Promise<ScheduledTaskDocument | null> {
    return scheduledTaskRepository.findById(id);
  }

  /** 获取用户运行记录（状态为成功或失败） */
  async listRunRecords(query: RunRecordQueryDto) {
    return scheduledTaskRepository.findRunRecords(query);
  }

  /** 创建定时任务 */
  async create(dto: CreateScheduledTaskDto): Promise<{ created: ScheduledTaskDocument } | { error: string }> {
    const created = await scheduledTaskRepository.create(dto);
    return { created };
  }

  /** 更新定时任务 */
  async update(id: string, dto: UpdateScheduledTaskDto): Promise<{ updated: ScheduledTaskDocument } | { error: string }> {
    const updated = await scheduledTaskRepository.updateById(id, dto);
    if (!updated) {
      return { error: '定时任务不存在' };
    }
    return { updated };
  }

  /** 删除定时任务（假删除） */
  async delete(id: string): Promise<{ error?: string }> {
    const deleted = await scheduledTaskRepository.softDeleteById(id);
    if (!deleted) {
      return { error: '定时任务不存在' };
    }
    return {};
  }

  /** 批量删除定时任务（假删除） */
  async batchDelete(ids: string[]): Promise<{ deletedCount: number }> {
    const deletedCount = await scheduledTaskRepository.softDeleteByIds(ids);
    return { deletedCount };
  }
}

export const scheduledTaskService = new ScheduledTaskService();
