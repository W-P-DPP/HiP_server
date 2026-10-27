/**
 * OAuth 授权服务器常量
 *
 * @author dpp
 */
export class OAuthConstants {
    /** 签发 access token 的 session scene */
    public static readonly ACCESS_TOKEN_SCENE: string = 'oauth:access';

    /** 签发 refresh token 的 session scene */
    public static readonly REFRESH_TOKEN_SCENE: string = 'oauth:refresh';

    /** 授权码有效期（毫秒，默认 5 分钟） */
    public static readonly AUTHORIZATION_CODE_TTL_MS: number = 5 * 60 * 1000;

    /** access token 默认有效期（秒，1 小时） */
    public static readonly DEFAULT_ACCESS_TOKEN_TTL: number = 3600;

    /** refresh token 默认有效期（秒，7 天） */
    public static readonly DEFAULT_REFRESH_TOKEN_TTL: number = 7 * 24 * 3600;

    /** 自动授权模式下的资源所有者 id */
    public static readonly DEFAULT_USER_ID: string = 'mcp';

    /** 运行时资源所有者 id（固定取 DEFAULT_USER_ID） */
    public static readonly USER_ID: string = OAuthConstants.DEFAULT_USER_ID;

    /** access token 运行时有效期（秒，固定取 DEFAULT_ACCESS_TOKEN_TTL） */
    public static readonly ACCESS_TOKEN_TTL: number = OAuthConstants.DEFAULT_ACCESS_TOKEN_TTL;

    /** refresh token 运行时有效期（秒，固定取 DEFAULT_REFRESH_TOKEN_TTL） */
    public static readonly REFRESH_TOKEN_TTL: number = OAuthConstants.DEFAULT_REFRESH_TOKEN_TTL;

    /** 支持的 scope */
    public static readonly SUPPORTED_SCOPES: string[] = ['mcp:tools'];
}
