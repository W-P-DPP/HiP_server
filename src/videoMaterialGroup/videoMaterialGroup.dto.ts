/** 素材分组创建入参 */
export interface CreateVideoMaterialGroupDto {
  /** 分组名称（必填；同一用户下未删除记录不重名） */
  name: string;
}

/** 素材分组更新入参 */
export interface UpdateVideoMaterialGroupDto {
  /** 分组名称 */
  name?: string;
}
