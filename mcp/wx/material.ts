import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { wxMaterialService } from "../../wx/material/wxMaterial.service.ts";
import { MEDIA_TYPES } from "../../utils/constant/wx.ts";
import { Logger } from "../../utils/Logger.ts";

const logger = Logger.getInstance();

/**
 * 微信公众号永久素材 MCP 工具集：按 files 集合的 fileId 上传为永久素材。
 */
export function registerWxMaterialTools(mcpServer: McpServer, ctx: { userId?: string }): void {
    /**
     * 新增微信公众号永久素材：复用 files 集合中已上传的文件（fileId 引用），
     * 调用微信 material/add_material 上传为永久素材并在 wxMaterials 集合落库，
     * 返回创建的素材记录（含 media_id，图片另含 url）。
     */
    mcpServer.registerTool(
        "add_material",
        {
            description: "新增微信公众号永久素材：按文件记录 id（fileId）引用 files 集合中已上传的文件，调用微信 material/add_material 接口上传为永久素材（image 图片 / voice 语音 / video 视频 / thumb 缩略图），并在 wxMaterials 集合持久化一条记录，返回创建的素材记录（含 media_id）。注意：视频素材（type=video）必须同时提供 title、introduction 参数。",
            inputSchema: z.object({
                fileId: z.string().min(1).describe("文件记录 id（files 集合），如 6a928767ee57934f7e5c0885"),
                type: z.enum(MEDIA_TYPES).describe("素材类型：image 图片 / voice 语音 / video 视频 / thumb 缩略图"),
                title: z.string().optional().describe("视频素材标题（type=video 时必填）"),
                introduction: z.string().optional().describe("视频素材简介（type=video 时必填）"),
            }).superRefine((val, ctx) => {
                if (val.type === 'video') {
                    if (!val.title) {
                        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: '视频素材必须携带 title 参数' });
                    }
                    if (!val.introduction) {
                        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['introduction'], message: '视频素材必须携带 introduction 参数' });
                    }
                }
            }),
        },
        async ({ fileId, type, title, introduction }) => {
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
            logger.info(`mcp 新增永久素材开始,userId:${ctx.userId};fileId:${fileId};type:${type}`);
            const result = await wxMaterialService.addMaterialByFileId(ctx.userId, fileId, { type, title, introduction });
            if ('error' in result) {
                logger.info(`mcp 新增永久素材失败,userId:${ctx.userId};fileId:${fileId};type:${type};error:${result.error}`);
            } else {
                logger.info(`mcp 新增永久素材成功,userId:${ctx.userId};fileId:${fileId};type:${type};mediaId:${result.created.mediaId}`);
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
