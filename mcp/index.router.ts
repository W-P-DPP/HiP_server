import { Router } from "express";
import { mcptest } from "./index.ts";
import { requireMcpAuth } from "./oauth/index.ts";
import { uuidValidateMiddleware } from "../utils/middleware/uuidMiddleware.ts";

const router: Router = Router();

// Streamable HTTP 协议需要同时处理 GET(SSE 事件流) / POST(JSON-RPC) / DELETE(关闭会话)
// MCP 请求统一先过 OAuth Bearer 鉴权（Authorization: Bearer <access_token>）
router.get('/', uuidValidateMiddleware, mcptest)
router.post('/', uuidValidateMiddleware, mcptest)
router.delete('/', uuidValidateMiddleware, mcptest)

export default router;
