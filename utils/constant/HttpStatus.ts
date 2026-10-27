/**
 * 返回状态码
 * 
 * @author dpp
 */
export class HttpStatus {
    /**
     * 操作成功
     */
    public static readonly SUCCESS: number = 200;

    /**
     * 对象创建成功
     */
    public static readonly CREATED: number = 201;

    /**
     * 请求已经被接受
     */
    public static readonly ACCEPTED: number = 202;

    /**
     * 操作已经执行成功，但是没有返回数据
     */
    public static readonly NO_CONTENT: number = 204;

    /**
     * 资源已被移除
     */
    public static readonly MOVED_PERM: number = 301;

    /**
     * 重定向
     */
    public static readonly SEE_OTHER: number = 303;

    /**
     * 资源没有被修改
     */
    public static readonly NOT_MODIFIED: number = 304;

    /**
     * 参数列表错误（缺少，格式不匹配）
     */
    public static readonly BAD_REQUEST: number = 400;

    /**
     * 未授权
     */
    public static readonly UNAUTHORIZED: number = 401;

    /**
     * 访问受限，授权过期
     */
    public static readonly FORBIDDEN: number = 403;

    /**
     * 资源，服务未找到
     */
    public static readonly NOT_FOUND: number = 404;

    /**
     * 不允许的http方法
     */
    public static readonly BAD_METHOD: number = 405;

    /**
     * 资源冲突，或者资源被锁
     */
    public static readonly CONFLICT: number = 409;

    /**
     * 不支持的数据，媒体类型
     */
    public static readonly UNSUPPORTED_TYPE: number = 415;

    /**
     * 系统内部错误
     */
    public static readonly ERROR: number = 500;

    /**
     * 接口未实现
     */
    public static readonly NOT_IMPLEMENTED: number = 501;

    /**
     * 服务暂不可用（依赖的外部能力未启用/未就绪）
     */
    public static readonly SERVICE_UNAVAILABLE: number = 503;

    /**
     * 系统警告消息
     */
    public static readonly WARN: number = 601;
}