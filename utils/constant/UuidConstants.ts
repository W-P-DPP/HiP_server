/**
 * UUID 签发管理常量
 *
 * @author dpp
 */
export class UuidConstants {
    /** 默认 TTL：1 天（秒） */
    public static readonly DEFAULT_TTL: number = 86400;

    /** 永不过期标记：ttl 传入该值时 session 永不过期 */
    public static readonly NEVER_EXPIRE: string = '*';

    /** uuid 校验中间件读取 uuid 的请求头 */
    public static readonly UUID_HEADER: string = 'hip-uuid';
}
