import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { wxDraftService } from "../../wx/draft/wxDraft.service.ts";
import { Logger } from '../../utils/Logger.ts';

const logger = Logger.getInstance();

/**
 * 微信公众号草稿箱 MCP 工具集：Markdown → 草稿（纯透传，复用 REST 同一 service 单例）。
 */
export function registerWxDraftTools(mcpServer: McpServer, ctx: { userId?: string }): void {
    /**
     * 将 Markdown 文档发布为微信公众号草稿（写入公众号草稿箱）。
     * 正文图片用 ![alt](永久素材media_id) 引用素材 media_id，发布时自动重新上传为微信正文图片 URL
     * （draft/add 只接受 media/uploadimg 的 URL，外部 URL 会被过滤），超 1MB 的图片自动用 ffmpeg 压缩；
     * 首图或 thumb_media_id 作为封面，返回草稿 media_id。
     */
    mcpServer.registerTool(
        "publish_draft",
        {
            description: "将 Markdown 文档发布为微信公众号草稿（写入公众号草稿箱）。正文图片用 ![alt](永久素材media_id) 引用素材 media_id，发布时自动调用 media/uploadimg 换取微信正文图片 URL（draft/add 只接受该 URL，外部 URL 会被过滤），图片超过 1MB 时自动用 ffmpeg 压缩；首图或 thumb_media_id 作为封面，返回草稿 media_id。",
            inputSchema: z.object({
                markdown: z.string().min(1).describe("Markdown 正文，图片使用 ![alt](media_id) 嵌入永久素材"),
                title: z.string().optional().describe("文章标题（≤64字），缺省取 markdown 第一个一级标题"),
                author: z.string().optional().describe("作者（≤8字）"),
                digest: z.string().optional().describe("摘要（≤120字）"),
                content_source_url: z.string().optional().describe("原文链接"),
                thumb_media_id: z.string().optional().describe("封面图素材 media_id，缺省取第一张正文图"),
                need_open_comment: z.union([z.literal(0), z.literal(1)]).optional().describe("是否打开评论：1 开 / 0 关").default(1),
                only_fans_can_comment: z.union([z.literal(0), z.literal(1)]).optional().describe("仅粉丝可评论：1 是 / 0 否").default(0),
            })
        },
        async (args) => {
            if (!ctx.userId) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: '无法解析当前用户' }),
                        },
                    ],
                };
            }
            logger.info('mcp 发布草稿开始,userId:' + ctx.userId)
            const result = await wxDraftService.publishDraft(ctx.userId, args);
            logger.info('mcp 发布草稿结束,userId:' + ctx.userId)
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result)
                    }
                ]
            };
        }
    );
}
