import type { IWxSummaryReadSource } from './summary.entity.ts';

/** 发表内容详细数据查询入参 */
export interface GetSummaryDto {
  /** 查询目标的用户 id（getSummary 由请求方显式上传，不从 JWT 解析） */
  userId?: string;
  begin_date?: string;
  end_date?: string;
}

/** 落库记录字段（一条 detail_list 行展平；msgid + statDate 唯一）。不含基础字段，由 BaseMongoPlugin 默认值填充 */
export interface CreateWxSummaryRecord {
  /** 归属用户 id（隔离统计；必须显式写入，BaseMongoPlugin 的 pre('save') 对 insertMany/bulkWrite 不生效） */
  userId: string;
  /** 文章发布日期 */
  refDate: string;
  /** 微信文章 msgid（唯一键之一；存字符串避免 64 位精度丢失） */
  msgid: string;
  /** 发布类型 */
  publishType: number;
  /** 文章标题 */
  title: string;
  /** 文章原文链接 */
  contentUrl: string;
  /** 统计日期（唯一键之一） */
  statDate: string;
  /** 阅读人数 */
  readUser: number;
  /** 阅读来源分布 */
  readUserSource: IWxSummaryReadSource[];
  /** 分享人数 */
  shareUser: number;
  /** 在看人数 */
  zaikanUser: number;
  /** 点赞人数 */
  likeUser: number;
  /** 评论数 */
  commentCount: number;
  /** 收藏人数 */
  collectionUser: number;
  /** 赞赏金额（分） */
  praiseMoney: number;
  /** 关注来源阅读人数 */
  readSubscribeUser: number;
  /** 阅读率 */
  readDeliveryRate: number;
  /** 读完率 */
  readFinishRate: number;
  /** 平均阅读时长（秒） */
  readAvgActivetime: number;
}
