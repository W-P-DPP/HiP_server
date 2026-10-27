/**
 * 缓存的key 常量
 * 
 * @author dpp
 */
export class CacheConstants {

    // 公众号access_token redis key
    public static readonly ACCESS_TOKEN_KEY: string = "wxbot:access_token:";

    // 单点登录：用户当前有效 token 的 redis key（key = SSO_TOKEN_KEY + {userId}，value = 当前有效 token）
    public static readonly SSO_TOKEN_KEY: string = "wxbot:sso:token:";

    // 微信公众号数据（一个月）
    public static readonly WX_SUMMARY_MONTH: string = "wxbot:wx:summary:";

    // cmdc 平台模型列表（全平台一份，无用户维度）
    public static readonly CMDC_MODEL_LIST_KEY: string = "wxbot:cmdc:models";

    // cmdc 平台模型列表缓存过期时间（秒，1 天）
    public static readonly CMDC_MODEL_LIST_TTL: number = 86400;

}