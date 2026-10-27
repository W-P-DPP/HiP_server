import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth';
import { mcpOAuthProvider } from './provider.ts';
import { OAuthConstants } from '../../utils/constant/OAuthConstants.ts';
import { SystemConstants } from '../../utils/constant/SystemConstants.ts';

/** 授权服务器基础 URL（仅 origin，无路径）；SERVER_URL 非 localhost 必须 https */
function serverUrl(): URL {
  return new URL(SystemConstants.SERVER_URL);
}

/** MCP 受保护资源 URL */
function mcpServerUrl(): URL {
  return new URL('/hip/mcp', serverUrl());
}

/** 构建 OAuth 授权服务器路由（必须挂载在应用根路径） */
export function buildOAuthAuthRouter() {
  return mcpAuthRouter({
    provider: mcpOAuthProvider,
    issuerUrl: serverUrl(),
    resourceServerUrl: mcpServerUrl(),
    scopesSupported: OAuthConstants.SUPPORTED_SCOPES,
    resourceName: 'general-server',
  });
}

/** MCP 端点 Bearer 鉴权中间件（校验 Authorization: Bearer，401 时带 resource_metadata 引导发现） */
export const requireMcpAuth = requireBearerAuth({
  verifier: mcpOAuthProvider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl()),
});
