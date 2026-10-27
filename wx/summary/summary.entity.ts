import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 阅读来源单行（read_user_source 元素） */
export interface IWxSummaryReadSource {
  userCount: number;
  sceneDesc: string;
}

/** 发表内容发表详细数据：一条 detail_list 行展平后的落库字段（msgid + statDate 唯一） */
export interface IWxSummary extends IBaseMongoEntity {
  /** 归属用户 id（统计读取隔离依据；历史无主行 userId 为空，统计按“缺失”重抓打标） */
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

/** 落库 Mongoose Document 类型 */
export type WxSummaryDocument = BaseDocument & IWxSummary;

const WxSummarySchema = new mongoose.Schema<WxSummaryDocument>(
  {
    userId: { type: String, required: true },
    refDate: { type: String, required: true },
    msgid: { type: String, required: true },
    publishType: { type: Number, default: 0 },
    title: { type: String, default: '', trim: true },
    contentUrl: { type: String, default: '' },
    statDate: { type: String, required: true },
    readUser: { type: Number, default: 0 },
    readUserSource: {
      type: [
        {
          userCount: { type: Number, default: 0 },
          sceneDesc: { type: String, default: '' },
        },
      ],
      default: [],
    },
    shareUser: { type: Number, default: 0 },
    zaikanUser: { type: Number, default: 0 },
    likeUser: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    collectionUser: { type: Number, default: 0 },
    praiseMoney: { type: Number, default: 0 },
    readSubscribeUser: { type: Number, default: 0 },
    readDeliveryRate: { type: Number, default: 0 },
    readFinishRate: { type: Number, default: 0 },
    readAvgActivetime: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: 'wxSummaries',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
WxSummarySchema.plugin(BaseMongoPlugin);

// 复合唯一索引：msgid + statDate 幂等去重依据（也服务 msgid 前缀查询）
WxSummarySchema.index({ msgid: 1, statDate: 1 }, { unique: true });
// 按统计日期做时间范围聚合
WxSummarySchema.index({ statDate: 1 });
// 按发布日期聚合
WxSummarySchema.index({ refDate: 1 });
// 按用户 + 发布日期范围查询（statistics 每日 DB 读取，多公众号同库隔离）
WxSummarySchema.index({ userId: 1, refDate: 1 });

const WxSummaryModel = MongoDBService.getInstance()
  .getMongoose()
  .model<WxSummaryDocument>('WxSummary', WxSummarySchema);

export default WxSummaryModel;
