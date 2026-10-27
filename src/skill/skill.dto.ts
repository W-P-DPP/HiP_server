import type { SkillStatus } from './skill.entity.ts';

/** 创建 Skill 入参 */
export interface CreateSkillDto {
  key: string;
  name: string;
  filePath?: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  tags?: string[];
  icon?: string;
  folders?: string[];
  configSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** 更新 Skill 入参（禁止修改 key） */
export interface UpdateSkillDto {
  name?: string;
  filePath?: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  tags?: string[];
  icon?: string;
  folders?: string[];
  configSchema?: Record<string, unknown>;
  status?: SkillStatus;
  metadata?: Record<string, unknown>;
}

/** Skill 查询参数 */
export interface SkillQueryDto {
  category?: string | undefined;
  tags?: string | undefined;
  status?: SkillStatus | undefined;
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
