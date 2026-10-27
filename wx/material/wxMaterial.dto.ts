import type { WxMediaType, IWxResponse } from '../../utils/wx/wx.d.ts';

/** 新增素材入参 */
export interface AddMaterialDto {
  type: WxMediaType;
  title?: string;
  introduction?: string;
}

/** 新增上传记录字段 */
export interface CreateWxMaterialRecord {
  type: WxMediaType;
  mediaId: string;
  url?: string;
  fileName: string;
  fileSize: number;
  filePath: string;
  title?: string;
  introduction?: string;
}

/** 删除永久素材 / 获取永久素材详情 / 获取临时素材 入参 */
export interface MediaIdParamsDto {
  media_id: string;
}

/** 获取永久素材列表入参（type 支持 image/video/voice/news，offset 从 0 起，count 1~20） */
export interface BatchGetMaterialDto {
  type: WxMediaType | 'news';
  offset: number;
  count: number;
}

/** 删除永久素材结果：微信侧数据 + 本地 wxMaterials 记录标记删除数量 */
export interface DelMaterialResult extends IWxResponse {
  localDeletedCount: number;
}
