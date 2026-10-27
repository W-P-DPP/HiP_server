import type { TaskRunStatus } from './taskRun.entity.ts';

/** 创建运行记录入参 */
export interface CreateTaskRunDto {
  /** 关联的定时任务 id */
  taskId: string;
  /** 任务标题快照 */
  taskTitle?: string | undefined;
  /** 所属用户 id */
  userId: string;
  /** 运行结果状态 */
  status: TaskRunStatus;
  /** 结果信息 / 错误信息 */
  message?: string | undefined;
  /** 开始执行时间（ISO 字符串） */
  startedAt?: string | undefined;
  /** 结束执行时间（ISO 字符串） */
  finishedAt?: string | undefined;
}

/** 更新运行记录入参 */
export interface UpdateTaskRunDto {
  taskId?: string;
  taskTitle?: string | undefined;
  userId?: string;
  status?: TaskRunStatus;
  message?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
}

/** 运行记录查询参数（可选字段显式加 | undefined，适配 exactOptionalPropertyTypes） */
export interface TaskRunQueryDto {
  userId?: string | undefined;
  taskId?: string | undefined;
  status?: TaskRunStatus | undefined;
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
