import { isMediaIdSrc } from '../constant/wx.ts';

export interface WxArticleImagesResult {
  /** 处理后的 HTML，media_id 图片已注入 data-mediaid */
  html: string;
  /** 按出现顺序收集的永久素材 media_id（供 image_list / 封面使用） */
  imageMediaIds: string[];
}

/**
 * 对净化后的 HTML 做图片后处理：src 为微信永久素材 media_id 时注入 data-mediaid 并按序收集，
 * 真实 URL 原样保留。需在 md2html 净化之后执行（xss 白名单不含 data-*）。
 */
export const processArticleImages = (html: string): WxArticleImagesResult => {
  const imageMediaIds: string[] = [];
  const processed = html.replace(
    /<img\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>/gi,
    (whole, prefix: string, src: string, suffix: string) => {
      if (!isMediaIdSrc(src)) return whole;
      imageMediaIds.push(src);
      // 重建标签：去掉 prefix 尾随空格避免 `<img  src>` 双空格
      return `<img${prefix.replace(/ +$/, '')} src="${src}" data-mediaid="${src}"${suffix}>`;
    },
  );
  return { html: processed, imageMediaIds };
};

/**
 * 把正文图片的 src（media_id）替换为微信正文可用 URL（media/uploadimg 返回值）。
 * draft/add 正文只接受该接口的 URL，外部 URL 会被过滤；未命中映射的图片保持原样。
 */
export const replaceImageSrcByMediaId = (
  html: string,
  urlByMediaId: Map<string, string>,
): string =>
  html.replace(
    /<img\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>/gi,
    (whole, prefix: string, src: string, suffix: string) => {
      const url = urlByMediaId.get(src);
      if (!url) return whole;
      return `<img${prefix.replace(/ +$/, '')} src="${url}"${suffix}>`;
    },
  );

/** 提取 markdown 首个一级标题（# xxx），供缺省 title 使用 */
export const extractFirstH1 = (markdown: string): string | undefined =>
  /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
