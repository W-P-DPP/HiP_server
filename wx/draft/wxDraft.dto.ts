/**
 * 发布草稿入参：markdown 正文（图片以 ![alt](永久素材media_id) 嵌入），其余字段可选。
 * 纯透传微信 draft/add，不落本地库。
 */
export interface PublishDraftDto {
  /** Markdown 正文 */
  markdown: string;
  /** 文章标题（≤64 字），缺省取 markdown 首个一级标题 */
  title?: string;
  /** 作者（≤8 字） */
  author?: string;
  /** 摘要（≤120 字） */
  digest?: string;
  /** 原文链接 */
  content_source_url?: string;
  /** 封面图素材 media_id，缺省取第一张正文图 */
  thumb_media_id?: string;
  /** 是否打开评论：0 关 / 1 开 */
  need_open_comment?: number;
  /** 仅粉丝可评论：0 否 / 1 是 */
  only_fans_can_comment?: number;
}
