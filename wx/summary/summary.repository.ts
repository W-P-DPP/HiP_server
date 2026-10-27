import WxSummaryModel, { type WxSummaryDocument } from './summary.entity.ts';
import type { CreateWxSummaryRecord } from './summary.dto.ts';

/** 判断是否为重复键（E11000）批量写入错误：顶层 code 11000，或所有 writeErrors 均为 11000 */
function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; writeErrors?: Array<{ code?: number }> };
  if (e.code === 11000) return true;
  if (Array.isArray(e.writeErrors)) {
    return e.writeErrors.length > 0 && e.writeErrors.every((we) => we.code === 11000);
  }
  return false;
}

class WxSummaryRepository {
  /** 查询某用户某发布日的全部行（statistics 每日 DB 命中路径；排除软删行） */
  async findByUserAndRefDate(userId: string, refDate: string): Promise<WxSummaryDocument[]> {
    return WxSummaryModel.find({ userId, refDate, flag: 1 });
  }

  /**
   * 按 { msgid, statDate } 幂等 upsert 落库发表内容详细数据。
   * - $set 整条记录（含 userId + flag:1）→ 新行插入即打标；旧的无主重复行被 $set 打上 userId（数据愈合）；
   * - filter 故意不带 userId：msgid 平台全局唯一，跨账号不重复，这样能命中并修复历史无主行；
   * - ordered:false + 吞并发 upsert 竞态下的 E11000（幂等），其余错误（校验 code 121、网络等）原样抛出。
   * 注意：bulkWrite 不触发 BaseMongoPlugin 中间件，userId 依赖记录本身已显式写入。
   */
  async upsertMany(records: CreateWxSummaryRecord[]): Promise<void> {
    if (records.length === 0) return;
    try {
      await WxSummaryModel.bulkWrite(
        records.map((rec) => ({
          updateOne: {
            filter: { msgid: rec.msgid, statDate: rec.statDate },
            update: { $set: { ...rec, flag: 1 } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
  }
}

export const wxSummaryRepository = new WxSummaryRepository();
