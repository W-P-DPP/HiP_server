// utils/constant/SystemConstants.ts
/**
 * 系统级常量：版本号、进程时区、服务器公网基础地址。
 *
 * 这三项是「应用自身」而非某个业务域的配置，被系统接口、OAuth 授权服务器、文件下载链接等多处消费。
 */
import { envStr } from './envParse.ts';

export class SystemConstants {
  /** 本服务版本号（HIP_VERSION）。/system/version 与 /system/cloudVersion 使用 */
  public static readonly VERSION: string = envStr('HIP_VERSION');

  /** 进程时区。容器默认 UTC，需显式指定；dayjs 格式化与字符串日期解析按此走 */
  public static readonly TIMEZONE: string = 'Asia/Shanghai';

  /**
   * 服务器公网可达的基础地址（仅 origin，不含路径）。
   *
   * 保留原始值（不在此去尾斜杠）：getVersion 直接把它拼在路径前，而 OAuth / 文件下载链接
   * 需要 origin，各自按需 stripTrailingSlash。
   */
  public static readonly SERVER_URL: string = envStr('SERVER_URL');
}
