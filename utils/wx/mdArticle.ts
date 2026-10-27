import { md2html } from '../md2html.ts';
import {
  processArticleImages,
  replaceImageSrcByMediaId,
  extractFirstH1,
  type WxArticleImagesResult,
} from './articleImages.ts';

export type MdToWxArticleResult = WxArticleImagesResult;
export { processArticleImages, replaceImageSrcByMediaId, extractFirstH1 };

/**
 * Markdown → 微信草稿正文 HTML。
 * preserveImgSrcMediaId：xss 默认会把非 URL 的 img src 清空，需保留 media_id 供 processArticleImages
 * 后处理注入 data-mediaid。
 */
export const mdToWxArticle = (markdown: string): MdToWxArticleResult =>
  processArticleImages(md2html(markdown, { preserveImgSrcMediaId: true }));
