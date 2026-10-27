import WxMaterialModel, { type WxMaterialDocument } from './wxMaterial.entity.ts';
import type { CreateWxMaterialRecord } from './wxMaterial.dto.ts';

class WxMaterialRepository {
  /** 新增上传记录 */
  async create(record: CreateWxMaterialRecord): Promise<WxMaterialDocument> {
    return WxMaterialModel.create(record);
  }

  /**
   * 假删除：按 media_id 将 flag 置 0（1 未删除 / 0 已删除，BaseMongoPlugin 约定）
   * 只翻转仍为 flag:1 的记录，返回实际标记删除的数量
   */
  async softDeleteByMediaId(mediaId: string): Promise<number> {
    const result = await WxMaterialModel.updateMany({ mediaId, flag: 1 }, { flag: 0 });
    return result.modifiedCount ?? 0;
  }

  /** 按 media_id 查询未删除的素材记录 */
  async findByMediaId(mediaId: string): Promise<WxMaterialDocument | null> {
    return WxMaterialModel.findOne({ mediaId, flag: 1 });
  }
}

export const wxMaterialRepository = new WxMaterialRepository();
