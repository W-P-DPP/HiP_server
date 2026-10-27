import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { wxSummaryService } from "../../wx/summary/summary.service.ts";
import { Logger } from "../../utils/Logger.ts";
import dayjs from "dayjs";

const logger = Logger.getInstance();

/**
 * 微信公众号已发布内容数据 MCP 工具集：datacube/getarticletotaldetail 拉取已发布图文统计详细数据
 * （阅读/分享/在看/点赞/评论/收藏/赞赏），经 summary service 落库后透传微信原始响应。
 */
export function registerWxFreePublishTools(mcpServer: McpServer, ctx: { userId?: string }): void {
    /**
     * 获取微信公众号已发布内容的数据：调用微信 datacube/getarticletotaldetail 接口，
     * 按日期区间返回每篇已发布图文的每日统计数据（ref_date/msgid/title/content_url/detail_list，
     * 含阅读人数 read_user、分享 share_user、在看 zaikan_user、点赞 like_user、评论 comment_count、
     * 收藏 collection_user、赞赏 praise_money 等）。日期缺省取昨天；微信数据有延迟，最新可查前一天。
     */
    mcpServer.registerTool(
        "get_published_content_data",
        {
            description: "获取微信公众号已发布内容的数据：调用微信 datacube/getarticletotaldetail 接口，按日期区间返回每篇已发布图文的每日统计数据（ref_date/msgid/title/content_url/detail_list，含阅读人数 read_user、分享 share_user、在看 zaikan_user、点赞 like_user、评论 comment_count、收藏 collection_user、赞赏 praise_money 等）。日期只能查前一天之前，当天不能查；begin_date、end_date都为同一天；",
            inputSchema: z.object({
                begin_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("开始日期 YYYY-MM-DD，缺省取昨天"),
                end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("结束日期 YYYY-MM-DD，缺省取昨天"),
            })
        },
        async ({ begin_date, end_date }) => {
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
            const date = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
            const info = { begin_date: begin_date ?? date, end_date: end_date ?? date };
            logger.info(`mcp 获取已发布内容数据开始,userId:${ctx.userId};begin_date:${info.begin_date};end_date:${info.end_date}`)
            const result = await wxSummaryService.getSummary(ctx.userId, info);
            if ('error' in result) {
                logger.info(`mcp 获取已发布内容数据失败,userId:${ctx.userId};error:${result.error}`)
            } else {
                logger.info(`mcp 获取已发布内容数据成功,userId:${ctx.userId};listCount:${result.list?.length ?? 0}`)
            }
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result),
                    },
                ],
            };
        }
    );
}
