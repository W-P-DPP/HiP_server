import dayjs from 'dayjs';
import { Logger } from '../../utils/Logger.ts';
import RedisService from '../../utils/Redis.ts';
import { CacheConstants } from '../../utils/constant/CacheConstants.ts';
import { getSecondsToNextMidnight } from '../../utils/date.ts';
import type {
  IWxArticleTotalDetail,
  IWxArticleTotalDetailItem,
  IWxArticleTotalDetailResponse,
} from '../../utils/wx/wx.d.ts';
import { articleTotalDetail } from '../../utils/wx/articlesummary.ts';
import { wxSummaryRepository } from './summary.repository.ts';
import { wxAccountService } from '../../src/wxAccount/wxAccount.service.ts';
import type { WxSummaryDocument } from './summary.entity.ts';
import type { CreateWxSummaryRecord } from './summary.dto.ts';

const logger = Logger.getInstance();
const redis = RedisService.getInstance();

class WxSummaryService {
  /** 获取发表内容发表详细数据并落库；仍向调用方返回微信原始响应 */
  async getSummary(
    userId: string,
    info: IWxArticleTotalDetail,
  ): Promise<IWxArticleTotalDetailResponse | { error: string }> {
    // 守卫：先确认该用户配置了启用状态的公众号，未配置则直接返回，不做缓存/落库/微信调用等后续步骤
    if (!(await wxAccountService.hasActiveAccount(userId))) {
      return { error: '该用户未配置公众号，无法获取统计数据' };
    }

    // 缓存 key 按 userId + 开始时间隔离（每天 0 点过期）
    const cacheKey = `${CacheConstants.WX_SUMMARY_MONTH}${userId}:${info.begin_date}`;

    // 优先读缓存，命中直接返回，避免重复请求微信接口
    try {
      const cached = await redis.getJSON<IWxArticleTotalDetailResponse>(cacheKey);
      if (cached) {
        logger.info(`发表内容统计命中缓存：${cacheKey}`);
        return cached;
      }
    } catch (cacheErr) {
      // 读缓存失败不阻断返回，降级走微信取数
      logger.error(
        `读取 summary 缓存失败：${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
      );
    }

    try {
      const res = await articleTotalDetail(userId, info);

      const records = this.flattenToRecords(res, userId);
      try {
        await wxSummaryRepository.upsertMany(records);
        logger.info(`发表内容发表详细数据落库成功：${records.length} 行`);
      } catch (saveErr) {
        // 落库失败不阻断返回（幂等去重，下次抓取自愈），仅记录日志
        logger.error(
          `发表内容发表详细数据落库失败：${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
        );
      }

      // 只缓存成功结果；TTL = 距次日 0 点的秒数（每天 0 点过期）
      try {
        await redis.setJSON(cacheKey, res, getSecondsToNextMidnight());
      } catch (cacheErr) {
        logger.error(
          `写入 summary 缓存失败：${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
        );
      }

      return res;
    } catch (err) {
      return { error: err instanceof Error ? err.message : '获取统计数据失败' };
    }
  }

  /** 将 list 中每条 detail_list 行展平为一条落库记录（for...of 规避 noUncheckedIndexedAccess） */
  private flattenToRecords(
    res: IWxArticleTotalDetailResponse,
    userId: string,
  ): CreateWxSummaryRecord[] {
    const records: CreateWxSummaryRecord[] = [];
    for (const item of res.list ?? []) {
      for (const row of item.detail_list ?? []) {
        records.push({
          userId,
          refDate: item.ref_date,
          msgid: item.msgid,
          publishType: item.publish_type,
          title: item.title,
          contentUrl: item.content_url,
          statDate: row.stat_date,
          readUser: row.read_user,
          readUserSource: (row.read_user_source ?? []).map((src) => ({
            userCount: src.user_count,
            sceneDesc: src.scene_desc,
          })),
          shareUser: row.share_user,
          zaikanUser: row.zaikan_user,
          likeUser: row.like_user,
          commentCount: row.comment_count,
          collectionUser: row.collection_user,
          praiseMoney: row.praise_money,
          readSubscribeUser: row.read_subscribe_user,
          readDeliveryRate: row.read_delivery_rate,
          readFinishRate: row.read_finish_rate,
          readAvgActivetime: row.read_avg_activetime,
        });
      }
    }
    return records;
  }

  /**
   * 数据统计：按 msgid（文章）维度返回入参时间段内公众号数据（每日明细）。
   *
   * 数据库可能存在历史缺失，故按天回填，每天 d 依次走：
   *   redis（wxbot:wx:summary:{userId}:{d}）→ 数据库（userId + refDate=d）→ 远端微信 getarticletotaldetail
   * 远端微信 getarticletotal 仅支持 begin=end 同一天查询、且不可查“当天”（只能查昨天及以前），
   * 因此每天的远端查询固定传 { begin_date: d, end_date: d }，并对今天/未来直接跳过不调远端。
   * 单日远端失败（61501 date range error 等）只记日志并在返回中标记 failedDays，不阻断整段查询；
   * redis/DB 读写失败一律记日志降级到下一来源。
   * 返回前把每篇文章的 detail_list 裁剪到 stat_date <= end_date。
   *
   * @param info begin_date/end_date 已由 controller 校验为 YYYY-MM-DD 且 begin<=end
   */
  async statistics(
    userId: string,
    info: IWxArticleTotalDetail,
  ): Promise<{ list: IWxArticleTotalDetailItem[]; failedDays?: string[] } | { error: string }> {
    // 守卫：先确认该用户配置了启用状态的公众号，未配置则直接返回，避免逐日记 failedDays 并白调微信接口
    if (!(await wxAccountService.hasActiveAccount(userId))) {
      return { error: '该用户未配置公众号，无法获取统计数据' };
    }

    const { begin_date, end_date } = info;
    const byMsg = new Map<string, IWxArticleTotalDetailItem>();
    const failedDays: string[] = [];
    try {
      let cursor = dayjs(begin_date);
      const end = dayjs(end_date);
      // 逐日升序回填；msgid 只属于唯一发布日，Map 天然去重且按发布日稳定排序
      for (; !cursor.isAfter(end); cursor = cursor.add(1, 'day')) {
        const d = cursor.format('YYYY-MM-DD');
        const dayResult = await this.resolveDay(userId, d);
        if (dayResult.failed) failedDays.push(d);
        for (const item of dayResult.items) byMsg.set(item.msgid, item);
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : '获取统计数据失败' };
    }
    const list = Array.from(byMsg.values());
    for (const item of list) {
      item.detail_list = item.detail_list.filter((row) => row.stat_date <= end_date);
    }
    return failedDays.length > 0 ? { list, failedDays } : { list };
  }

  /**
   * 解析单个发布日 d 的数据，来源链：redis → db → 远端。
   * - redis 命中以 key「存在」为准（含当日无文章的 { list: [] }），并过滤 ref_date === d 防御历史多日缓存 blob；
   * - DB 命中（userId + refDate=d 有行）重建 item 并回写 redis；
   * - 两者都没有才调远端微信（固定 begin=end=d 单日；今天/未来跳过不查），落库（upsert 打 userId）+ 写 redis。
   * - 单日远端失败（如 61501 date range error）不抛错：置 failed=true 由 statistics 归入 failedDays 并继续后续天。
   *
   * @returns items 当天文章列表；failed 表示当天远端数据拉取失败（redis/DB 均无且远端报错）
   */
  private async resolveDay(
    userId: string,
    d: string,
  ): Promise<{ items: IWxArticleTotalDetailItem[]; failed?: boolean }> {
    const cacheKey = `${CacheConstants.WX_SUMMARY_MONTH}${userId}:${d}`;

    // 1) redis
    try {
      const cached = await redis.getJSON<IWxArticleTotalDetailResponse>(cacheKey);
      if (cached) {
        logger.info(`数据统计命中缓存：${cacheKey}`);
        return { items: cached.list.filter((it) => it.ref_date === d) };
      }
    } catch (cacheErr) {
      logger.error(
        `读取 summary 统计缓存失败：${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
      );
    }

    // 2) 数据库
    let rows: WxSummaryDocument[] = [];
    try {
      rows = await wxSummaryRepository.findByUserAndRefDate(userId, d);
    } catch (dbErr) {
      logger.error(
        `查询 summary 统计数据失败：${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }
    if (rows.length > 0) {
      const items = this.rowsToItems(rows);
      try {
        await redis.setJSON(cacheKey, { list: items }, getSecondsToNextMidnight());
        logger.info(`数据统计回写缓存：${cacheKey}`);
      } catch (cacheErr) {
        logger.error(
          `写入 summary 统计缓存失败：${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
        );
      }
      return { items };
    }

    // 3) 远端微信：只查昨天及以前（getarticletotal 不可查当天，查今天会 61501 date range error）
    const today = dayjs().format('YYYY-MM-DD');
    if (d >= today) {
      logger.info(`数据统计跳过远端查询：${d} 为今天/未来，微信无数据`);
      return { items: [] };
    }
    try {
      const res = await articleTotalDetail(userId, { begin_date: d, end_date: d });
      try {
        await wxSummaryRepository.upsertMany(this.flattenToRecords(res, userId));
        logger.info(`数据统计远端落库成功：${res.list?.length ?? 0} 条`);
      } catch (saveErr) {
        logger.error(
          `数据统计远端落库失败：${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
        );
      }
      try {
        await redis.setJSON(cacheKey, res, getSecondsToNextMidnight());
      } catch (cacheErr) {
        logger.error(
          `写入 summary 统计缓存失败：${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
        );
      }
      return { items: res.list ?? [] };
    } catch (remoteErr) {
      // 单日远端失败不阻断整体：旧日期可能已超出微信可查范围；置 failed 由 statistics 汇总返回 failedDays
      logger.error(
        `数据统计远端获取失败 ${d}：${remoteErr instanceof Error ? remoteErr.message : String(remoteErr)}`,
      );
      return { items: [], failed: true };
    }
  }

  /** 将某发布日的一组落库行还原为 WeChat 形状的文章 item（与 flattenToRecords 互为逆映射） */
  private rowsToItems(rows: WxSummaryDocument[]): IWxArticleTotalDetailItem[] {
    const byMsg = new Map<string, WxSummaryDocument[]>();
    for (const row of rows) {
      const group = byMsg.get(row.msgid);
      if (group) group.push(row);
      else byMsg.set(row.msgid, [row]);
    }
    const items: IWxArticleTotalDetailItem[] = [];
    for (const group of byMsg.values()) {
      const head = group[0];
      if (!head) continue; // 规避 noUncheckedIndexedAccess；分组非空恒有首行
      items.push({
        ref_date: head.refDate,
        msgid: head.msgid,
        publish_type: head.publishType,
        title: head.title,
        content_url: head.contentUrl,
        detail_list: group
          .map((r) => ({
            stat_date: r.statDate,
            read_user: r.readUser,
            read_user_source: (r.readUserSource ?? []).map((s) => ({
              user_count: s.userCount,
              scene_desc: s.sceneDesc,
            })),
            share_user: r.shareUser,
            zaikan_user: r.zaikanUser,
            like_user: r.likeUser,
            comment_count: r.commentCount,
            collection_user: r.collectionUser,
            praise_money: r.praiseMoney,
            read_subscribe_user: r.readSubscribeUser,
            read_delivery_rate: r.readDeliveryRate,
            read_finish_rate: r.readFinishRate,
            read_avg_activetime: r.readAvgActivetime,
          }))
          .sort((a, b) => (a.stat_date < b.stat_date ? -1 : 1)),
      });
    }
    return items;
  }
}

/** statistics 单次查询最大跨度（天，含首尾），防止过多逐日微信请求 */
export const STATISTICS_MAX_RANGE_DAYS = 31;

export const wxSummaryService = new WxSummaryService();
