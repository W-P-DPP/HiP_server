/** 文件查询参数 */
export interface FileQueryDto {
  category?: string | undefined;
  mimeType?: string | undefined;
  keyword?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

/** 文件更新入参 */
export interface UpdateFileDto {
  originalName?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

/** 分页响应 */
export interface PaginatedResponse<T> {
  list: T[];
  total: number;
  page: number;
  limit: number;
}

/** 上传选项 */
export interface UploadOptions {
  /** 文件分类 */
  category?: string;
  /** 创建者 */
  createBy?: string;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}
