import { draftAdd as wxDraftAdd } from '../../utils/wx/draft.ts';
import { mdToWxArticle, replaceImageSrcByMediaId, extractFirstH1 } from '../../utils/wx/mdArticle.ts';
import { wxMaterialService } from '../material/wxMaterial.service.ts';
import type { IWxDraft, IWxDraftResponse } from '../../utils/wx/wx.d.ts';
import type { PublishDraftDto } from './wxDraft.dto.ts';

// 微信字段限制（防呆截断）
const TITLE_MAX = 64; // 图文消息标题 ≤64 字
const DIGEST_MAX = 120; // 摘要 ≤120 字
const AUTHOR_MAX = 8; // 作者 ≤8 字
const IMAGE_LIST_MAX = 20; // image_list 最多 20 张

class WxDraftService {
  /**
   * 发布草稿：Markdown → HTML → 正文图片（media_id）换成 media/uploadimg 的正文 URL
   * → 微信 /cgi-bin/draft/add。纯透传微信响应，不落本地库。REST 与 MCP 共用此单例。
   */
  async publishDraft(
    userId: string,
    dto: PublishDraftDto,
  ): Promise<{ data: IWxDraftResponse } | { error: string }> {
    try {
      const { html, imageMediaIds } = mdToWxArticle(dto.markdown);
      const content = replaceImageSrcByMediaId(html, await this.resolveContentImageUrls(userId, imageMediaIds));

      const title = (dto.title?.trim() || extractFirstH1(dto.markdown))?.slice(0, TITLE_MAX);
      if (!title) {
        throw new Error('标题缺失：请传入 title，或在 Markdown 首行使用 "# 标题"');
      }

      const thumbMediaId = dto.thumb_media_id ?? imageMediaIds[0];
      if (!thumbMediaId) {
        throw new Error('至少需要一张图片作为封面：请在 Markdown 中嵌入永久素材图片，或传入 thumb_media_id');
      }

      // image_list 收集正文图；内容无图时用封面兜底，保证 valiArticlesInfo 的 image_list 校验通过
      const imageList =
        imageMediaIds.length > 0 ? imageMediaIds.slice(0, IMAGE_LIST_MAX) : [thumbMediaId];

      const article: IWxDraft = {
        title,
        content,
        thumb_media_id: thumbMediaId,
        image_info: { image_list: imageList.map((image_media_id) => ({ image_media_id })) },
        ...(dto.author ? { author: dto.author.slice(0, AUTHOR_MAX) } : {}),
        ...(dto.digest ? { digest: dto.digest.slice(0, DIGEST_MAX) } : {}),
        ...(dto.content_source_url ? { content_source_url: dto.content_source_url } : {}),
        ...(dto.need_open_comment != null ? { need_open_comment: dto.need_open_comment } : {}),
        ...(dto.only_fans_can_comment != null
          ? { only_fans_can_comment: dto.only_fans_can_comment }
          : {}),
      };

      const data = await wxDraftAdd(userId, article);
      return { data };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '草稿发布失败' };
    }
  }

  /**
   * 正文图片 media_id → 微信正文可用 URL 映射。
   * draft/add 正文只接受 media/uploadimg 的 URL，任一图片解析失败即整体失败（避免静默丢图）。
   */
  private async resolveContentImageUrls(
    userId: string,
    imageMediaIds: string[],
  ): Promise<Map<string, string>> {
    const urlByMediaId = new Map<string, string>();
    for (const mediaId of new Set(imageMediaIds)) {
      const resolved = await wxMaterialService.getContentImageUrl(userId, mediaId);
      if ('error' in resolved) throw new Error(resolved.error);
      urlByMediaId.set(mediaId, resolved.url);
    }
    return urlByMediaId;
  }
}

export const wxDraftService = new WxDraftService();
