/** 素材创建入参（multipart：file + keyword + fileName? + groupId?，文本字段在 req.body） */
export interface CreateVideoMaterialDto {
  /** 来源搜索词（必填；新增/更新时按未删除记录判重，keyword 需唯一） */
  keyword: string;
  /** 展示文件名（默认取上传文件原始名） */
  fileName?: string;
  /** 所属分组 _id（可选，非必填） */
  groupId?: string;
}

/** 素材更新入参（multipart 可选：带 file 则替换关联文件，否则仅更新元数据） */
export interface UpdateVideoMaterialDto {
  /** 来源搜索词 */
  keyword?: string;
  /** 展示文件名 */
  fileName?: string;
  /** 所属分组 _id（空串表示移出分组） */
  groupId?: string;
  /** 内部使用：重新上传后回填的新文件 _id */
  fileId?: string;
}

/** 素材批量分组入参 */
export interface BatchGroupVideoMaterialDto {
  /** 目标素材 _id 列表（非空，全部为合法 ObjectId） */
  ids: string[];
  /** 目标分组 _id（空串表示移出分组） */
  groupId: string;
}

/** 素材分页查询参数 */
export interface VideoMaterialQueryDto {
  /** 搜索关键字（同时模糊匹配 keyword 与 fileName 字段） */
  keyword?: string;
  /** 上传者过滤（createBy 精确匹配；空串表示公共素材，服务层注入） */
  createBy?: string;
  /** 分组过滤（空串表示未分组） */
  groupId?: string;
  page?: number;
  limit?: number;
}

/** 分页响应 */
export interface PaginatedResponse<T> {
  list: T[];
  total: number;
  page: number;
  limit: number;
}
