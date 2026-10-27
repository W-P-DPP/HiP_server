import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { isValidObjectId } from 'mongoose';
import { fileService } from "../../src/file/file.service.ts";
import { Logger } from "../../utils/Logger.ts";
import { SystemConstants } from "../../utils/constant/SystemConstants.ts";
import type { FileDownload } from '../../type/index.d.ts';

const logger = Logger.getInstance();

/**
 * 按 fileId 校验记录存在，生成免 JWT 的真实下载地址。
 * MCP 请求已过 uuidValidateMiddleware（session 鉴权）无法携带 JWT，
 * 文件下载接口已在 app.ts 改为免 JWT 挂载，故这里直接返回可访问的下载 URL。
 */
async function downloadFileById(fileId: string): Promise<FileDownload.Result | { error: string }> {
    try {
        if (!isValidObjectId(fileId)) return { error: '文件不存在' };
        const file = await fileService.getById(fileId);
        if (!file) return { error: '文件不存在' };
        // 快失败：磁盘文件缺失就不下发 URL，避免给客户端一个死链（下载接口本身也会 404 兜底）
        if (!fileService.fileExistsOnDisk(file)) return { error: '文件在磁盘上不存在' };

        const serverUrl = SystemConstants.SERVER_URL.replace(/\/+$/, '');
        if (!serverUrl) return { error: '服务器基础地址未配置（SERVER_URL）' };
        // 路径前缀与 app.ts:18 一致：开发环境 /dev，其余（生产）为空
        const prefix = process.env.NODE_ENV === 'development' ? '/dev' : '';

        return {
            fileId: file._id.toString(),
            originalName: file.originalName,
            mimeType: file.mimeType,
            size: file.size,
            url: `${serverUrl}${prefix}/hip/api/files/${file._id.toString()}/download`,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : '文件下载失败';
        logger.error(`mcp 文件下载异常：${message}`);
        return { error: message };
    }
}

/**
 * 文件下载 MCP 工具：按 fileId 查库校验记录存在，返回真实下载地址（免 JWT，客户端直接访问）。
 */
export function registerFileDownloadTools(mcpServer: McpServer, ctx: { userId?: string }): void {
    mcpServer.registerTool(
        "download_file",
        {
            description: "按文件 id 获取下载地址：MCP 走 session(uuid) 鉴权无法携带 JWT，故文件下载接口已在服务端改为免 JWT 挂载；本工具校验文件记录存在后返回真实下载 URL，客户端用该 URL 即可直接下载文件。",
            inputSchema: z.object({
                fileId: z.string().min(1).describe("文件记录 id，如 6a928767ee57934f7e5c0885"),
            })
        },
        async ({ fileId }) => {
            logger.info(`mcp 文件下载开始,userId:${ctx.userId};fileId:${fileId}`);
            const result = await downloadFileById(fileId);
            // 成功日志不打印完整 url，避免下载地址散落服务日志
            if ('error' in result) {
                logger.info(`mcp 文件下载失败,userId:${ctx.userId};fileId:${fileId};error:${result.error}`);
            } else {
                logger.info(`mcp 文件下载成功,userId:${ctx.userId};fileId:${fileId};originalName:${result.originalName};size:${result.size}`);
            }
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
