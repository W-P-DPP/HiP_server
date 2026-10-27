import { freePublishBatchget as wxFreePublishBatchget } from '../../utils/wx/freePublish.ts';
import type { IWxFreePublishBatchget, IWxFreePublishBatchgetResponse, IWxResponse } from '../../utils/wx/wx.d.ts';

class WxFreePublishService {
  /**
   * 获取已发布内容列表：纯透传微信 freepublish/batchget 响应，不落本地库。REST 与 MCP 共用此单例。
   */
  async batchGet(
    userId: string,
    info: IWxFreePublishBatchget,
  ): Promise<{ data: IWxFreePublishBatchgetResponse & IWxResponse } | { error: string }> {
    try {
      const data = await wxFreePublishBatchget(userId, info);
      return { data };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '已发布内容列表获取失败' };
    }
  }
}

export const wxFreePublishService = new WxFreePublishService();
