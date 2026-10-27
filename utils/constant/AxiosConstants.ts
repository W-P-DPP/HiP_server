// utils/constant/AxiosConstants.ts
/** Axios 请求单例常量 */
export class AxiosConstants {
  /** 默认 baseURL（固定：微信公众号 API 网关） */
  public static readonly BASE_URL: string = 'https://api.weixin.qq.com/cgi-bin/';

  /** 请求超时时间（毫秒） */
  public static readonly TIMEOUT: number = 5000;
}
