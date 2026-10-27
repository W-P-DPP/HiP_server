import type { ScheduledTaskStatus } from './scheduledTask.entity.ts';

/** 创建定时任务入参 */
export interface CreateScheduledTaskDto {
  title: string;
  description?: string;
  cron: string;
  status?: ScheduledTaskStatus;
  userId: string;
}

/** 更新定时任务入参 */
export interface UpdateScheduledTaskDto {
  title?: string;
  description?: string;
  cron?: string;
  status?: ScheduledTaskStatus;
  userId?: string;
}

/** 批量删除定时任务入参 */
export interface BatchDeleteScheduledTaskDto {
  ids: string[];
}

/** 运行记录查询参数（用户运行状态为成功或失败的记录） */
export interface RunRecordQueryDto {
  userId: string;
  page?: number | undefined;
  limit?: number | undefined;
}

/** 定时任务查询参数（可选字段显式加 | undefined，适配 exactOptionalPropertyTypes） */
export interface ScheduledTaskQueryDto {
  userId?: string | undefined;
  status?: ScheduledTaskStatus | undefined;
  keyword?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

/** 分页响应 */
export interface PaginatedResponse<T> {
  list: T[];
  total: number;
  page: number;
  limit: number;
}
