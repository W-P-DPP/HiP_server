import type { UuidManage } from '../../type/index.d.ts';

/** 创建 Session 入参 */
export interface CreateSessionDto {
  /** 关联用户 id */
  userId: string;
  /** 业务场景（可选） */
  scene?: string;
  /** 会话名称（必填） */
  name: string;
  /** 有效期（秒）；传 '*' 表示永不过期；默认 UuidConstants.DEFAULT_TTL */
  ttl?: number | '*';
}

/** 更新 Session 入参（禁止修改 uuid / status / ttl） */
export interface UpdateSessionDto {
  /** 会话名称（传需非空） */
  name?: string;
  /** 业务场景 */
  scene?: string;
}

/** Session 查询参数 */
export interface SessionQueryDto {
  userId?: string | undefined;
  status?: UuidManage.Status | undefined;
  scene?: string | undefined;
  name?: string | undefined;
  keyword?: string | undefined;
  /** 是否包含已过期 Session（默认 true，管理视角） */
  includeExpired?: boolean | undefined;
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
