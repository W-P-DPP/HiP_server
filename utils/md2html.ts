import { marked } from "marked";
import xss from "xss";
import type { IWhiteList } from "xss";
import { isMediaIdSrc } from "./constant/wx.ts";

export interface Md2HtmlOptions {
  /** 启用 GFM（表格 / 删除线 / 任务列表等），默认 true */
  gfm?: boolean;
  /** 换行转 <br>，默认 false */
  breaks?: boolean;
  /** 是否净化 HTML（防 XSS），默认 true */
  sanitize?: boolean;
  /**
   * 保留 <img src> 的非 URL 值（微信永久素材 media_id 场景）。
   * xss 默认会把非 URL 形状的 src 值清空，开启后 img 的 src 为 media_id（非 URL）时原样保留，
   * 供上层注入 data-mediaid。默认 false，不影响既有调用。
   */
  preserveImgSrcMediaId?: boolean;
}

// xss 的 CJS 导出把默认白名单挂载在默认导出函数上（Object.assign），
// 类型未声明，这里做显式断言；ESM 下无法以命名导入方式读取。
const defaultWhiteList: IWhiteList = (xss as unknown as { whiteList: IWhiteList })
  .whiteList;

const XSS_WHITE_LIST: IWhiteList = {
  ...defaultWhiteList,
  // GFM 任务列表的复选框
  input: ["checked", "disabled", "type"],
  // 代码块语言高亮 class（language-xxx）
  code: ["class"],
  a: [...(defaultWhiteList["a"] ?? []), "rel"],
};

/**
 * Markdown 转 HTML（服务端安全转换，默认净化防 XSS）。
 * @param markdown - 原始 Markdown 文本
 * @param options - 转换选项
 * @returns 净化后的 HTML 字符串
 */
export const md2html = (
  markdown: string,
  options: Md2HtmlOptions = {}
): string => {
  if (!markdown) return "";

  const { gfm = true, breaks = false, sanitize = true, preserveImgSrcMediaId = false } = options;

  const html = marked.parse(markdown, {
    gfm,
    breaks,
    async: false,
  }) as string;

  if (!sanitize) return html;

  return xss(html, {
    whiteList: XSS_WHITE_LIST,
    stripIgnoreTag: true,
    // script/style 整段移除（含内容），避免残留文本再注入
    stripIgnoreTagBody: ["script", "style"],
    allowCommentTag: false,
    // 默认 safeAttrValue 会把非 URL 的 img src 值清空；media_id 场景需保留，后续由调用方注入 data-mediaid
    ...(preserveImgSrcMediaId
      ? {
          onTagAttr: (tag: string, name: string, value: string): string | undefined => {
            if (tag === "img" && name === "src" && isMediaIdSrc(value)) {
              return ` ${name}="${value.replace(/"/g, "&quot;")}"`;
            }
            return undefined; // 其余走默认净化逻辑
          },
        }
      : {}),
  });
};
