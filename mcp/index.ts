import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import { z } from "zod";
import type {
    Request,
    Response,
} from "express";
import { registerAutoVideoTools } from "./autoVideo/index.ts";
import { registerFileDownloadTools } from "./fileDownload/index.ts";
import { registerWxDraftTools } from "./wx/index.ts";
import { registerWxMaterialTools } from "./wx/material.ts";
import { registerWxFreePublishTools } from "./wx/freePublish.ts";
import { registerTest } from "./test.ts";
import { sessionRepository } from "../src/session/session.repository.ts";
import { registerDigitalHumanTools } from "./digitalHuman/digitalHuman.mcp.ts";
import { registerVideoPipelineV2Tools } from "./videoPipelineV2/videoPipeline.mcp.ts";
import { registerNarrationVideoTools } from "./narrationVideo/narrationVideo.mcp.ts";

/** 单次 MCP 请求的会话上下文（userId 从会话记录按 uuid 查库解析） */
interface McpRequestContext {
    userId?: string;
}

/**
 * 从会话解析归属用户：req.uuidSession 由 uuidValidateMiddleware 挂载（仅会话元信息），
 * userId 需按 uuid 查询数据库中的 session 记录。
 */
async function resolveSessionUser(req: Request): Promise<string | undefined> {
    const sessionUuid = req.uuidSession?.uuid;
    if (!sessionUuid) return undefined;
    const doc = await sessionRepository.findByUuid(sessionUuid);
    return doc?.userId;
}

function createMcpServer(ctx: McpRequestContext = {}) {
    const mcpServer = new McpServer({
        name: "general-server",
        version: "1.0.0"
    });
    registerTest(mcpServer)
    // registerAutoVideoTools(mcpServer, ctx);
    // registerFileDownloadTools(mcpServer, ctx);
    registerWxDraftTools(mcpServer, ctx);
    registerWxMaterialTools(mcpServer, ctx);
    // registerWxFreePublishTools(mcpServer, ctx);
    registerDigitalHumanTools(mcpServer, ctx);
    registerVideoPipelineV2Tools(mcpServer, ctx);
    registerNarrationVideoTools(mcpServer, ctx);
    return mcpServer;
}



export const mcptest = async (
    req: Request,
    res: Response
) => {

    const ctx: McpRequestContext = { userId: await resolveSessionUser(req) };
    const mcpServer = createMcpServer(ctx);
    const transport =
        new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });
    await mcpServer.connect(
        transport
    );
    await transport.handleRequest(
        req,
        res,
        req.body
    );
};