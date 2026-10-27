import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import type { AuthorizationParams, OAuthServerProvider, OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth';
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors';
import { oauthClientRepository } from '../../src/oauthClient/oauthClient.repository.ts';
import { uuidManageService } from '../../utils/service/UuidManageService.ts';
import { OAuthConstants } from '../../utils/constant/OAuthConstants.ts';
import { JwtConstants } from '../../utils/constant/JwtConstants.ts';

const JWT_SECRET = JwtConstants.SECRET;

/** JWT 载荷（access/refresh token 共用） */
interface TokenPayload {
  type: 'access' | 'refresh';
  clientId: string;
  userId: string;
  sessionUuid: string;
  scopes: string[];
  exp?: number;
}

/** authorize 阶段暂存的授权码记录 */
interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  resource?: URL;
  expiresAt: number;
}

/**
 * MCP OAuth 2.0 授权服务器 Provider
 *
 * - 客户端注册 → Mongo 持久化（oauthClientRepository）
 * - authorize 自动放行：直接签发授权码重定向（SDK demo 做法）
 * - access/refresh token 为 JWT（JWT_SECRET 签发），各自绑定 uuidManageService 的 session，
 *   撤销/轮换通过 session status==='active' 判断，实现真实吊销
 */
export class McpOAuthProvider implements OAuthServerProvider, OAuthTokenVerifier {
  /** 动态注册的客户端存储（Mongo 持久化） */
  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: async (clientId: string) => {
      const doc = await oauthClientRepository.findByClientId(clientId);
      return doc ? oauthClientRepository.toInfo(doc) : undefined;
    },
    registerClient: async (client) => {
      // 运行时 register handler 已注入 client_id / client_id_issued_at（及可选 client_secret）
      const full = client as OAuthClientInformationFull;
      await oauthClientRepository.create(full);
      return full;
    },
  };

  /** 内存授权码（短 TTL，5 分钟） */
  private readonly codes = new Map<string, AuthCodeRecord>();

  /** 自动放行：签发授权码并重定向到 redirect_uri */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // redirect_uri 已由 SDK authorize handler 对照注册表校验（含 loopback 端口放宽），此处仅兜底
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError('Unregistered redirect_uri');
    }

    const code = randomUUID();
    this.codes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      codeChallenge: params.codeChallenge,
      resource: params.resource,
      expiresAt: Date.now() + OAuthConstants.AUTHORIZATION_CODE_TTL_MS,
    });

    const url = new URL(params.redirectUri);
    url.searchParams.set('code', code);
    if (params.state !== undefined) {
      url.searchParams.set('state', params.state);
    }
    res.redirect(302, url.toString());
  }

  /** 返回授权码对应的 codeChallenge（SDK token handler 做 PKCE 校验） */
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const rec = this.codes.get(authorizationCode);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError('Invalid authorization code');
    }
    return rec.codeChallenge;
  }

  /** 授权码换 token（PKCE 已由 SDK token handler 校验，此处只核对归属/过期/redirect_uri） */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(authorizationCode);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError('Invalid authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError('redirect_uri does not match authorization request');
    }
    if (resource !== undefined && rec.resource !== undefined && resource.href !== rec.resource.href) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError('resource does not match authorization request');
    }
    this.codes.delete(authorizationCode);
    return this.issueTokens(client, rec.scopes);
  }

  /** refresh token 轮换：校验旧 refresh session → 签发新对 → 吊销旧 refresh session */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const payload = this.verifyJwt(refreshToken);
    if (!payload || payload.type !== 'refresh' || payload.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    const session = await uuidManageService.status(payload.sessionUuid);
    if (!session || session.status !== 'active') {
      throw new InvalidGrantError('Refresh token revoked or expired');
    }

    // 先签发新 token，成功后再吊销旧 refresh session（避免签发失败烧掉 refresh token）
    const tokens = await this.issueTokens(client, scopes ?? payload.scopes);
    await uuidManageService.revoke(payload.userId, payload.sessionUuid);
    return tokens;
  }

  /** 校验 access token 并返回 AuthInfo */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = this.verifyJwt(token);
    if (!payload || payload.type !== 'access') {
      throw new InvalidTokenError('Invalid access token');
    }
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError('Token has expired');
    }
    const session = await uuidManageService.status(payload.sessionUuid);
    if (!session || session.status !== 'active') {
      throw new InvalidTokenError('Token revoked or expired');
    }
    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scopes,
      expiresAt: payload.exp,
      extra: { userId: payload.userId, sessionUuid: payload.sessionUuid },
    };
  }

  /** 吊销 token（RFC 7009：无效 token 静默） */
  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const payload = this.verifyJwt(request.token);
    if (!payload) {
      return;
    }
    try {
      await uuidManageService.revoke(payload.userId, payload.sessionUuid);
    } catch {
      // 吊销失败不抛错（RFC 7009 建议对无效 token 无操作）
    }
  }

  /** 校验 JWT 签名/过期，失败返回 null */
  private verifyJwt(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch {
      return null;
    }
  }

  /** 签发 access + refresh token（各绑定一个 session，支持撤销） */
  private async issueTokens(client: OAuthClientInformationFull, scopes: string[]): Promise<OAuthTokens> {
    const userId = OAuthConstants.USER_ID;
    const accessTtl = OAuthConstants.ACCESS_TOKEN_TTL;
    const refreshTtl = OAuthConstants.REFRESH_TOKEN_TTL;

    const accessSession = await uuidManageService.issue(userId, OAuthConstants.ACCESS_TOKEN_SCENE, accessTtl);
    const refreshSession = await uuidManageService.issue(userId, OAuthConstants.REFRESH_TOKEN_SCENE, refreshTtl);

    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: jwt.sign(
        { type: 'access', clientId: client.client_id, userId, sessionUuid: accessSession, scopes, iat: now },
        JWT_SECRET,
        { expiresIn: accessTtl },
      ),
      token_type: 'bearer',
      expires_in: accessTtl,
      scope: scopes.join(' '),
      refresh_token: jwt.sign(
        { type: 'refresh', clientId: client.client_id, userId, sessionUuid: refreshSession, scopes, iat: now },
        JWT_SECRET,
        { expiresIn: refreshTtl },
      ),
    };
  }
}

export const mcpOAuthProvider = new McpOAuthProvider();
