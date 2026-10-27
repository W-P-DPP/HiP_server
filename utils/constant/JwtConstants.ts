// utils/constant/JwtConstants.ts
/** JWT 认证常量 */
import { envBool, envStr } from './envParse.ts';

export class JwtConstants {
  /** 是否启用强制鉴权（JWT_ENABLED=true）。开发/测试默认关闭，走 best-effort 解码 */
  public static readonly ENABLED: boolean = envBool('JWT_ENABLED', false);

  /** 签名密钥（JWT_SECRET）。未配置时用占位值，避免签发/校验直接抛错 */
  public static readonly SECRET: string = envStr('JWT_SECRET', 'default_secret_key');

  /** token 过期时间（秒） */
  public static readonly EXPIRES_IN: number = 7200;
}
