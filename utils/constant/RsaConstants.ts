/** RSA 密码解密常量 */
export class RsaConstants {
  /** 私钥 PEM 路径缺省值（相对 process.cwd()，env RSA_PRIVATE_KEY_PATH 可覆盖） */
  public static readonly DEFAULT_PRIVATE_KEY_PATH: string = './keys/rsa_private.pem';
  /** RSA 2048 位密文长度（恒等于模长，256 字节） */
  public static readonly CIPHER_BYTE_LENGTH: number = 256;
  /** PKCS#1 v1.5 填充块最小长度：0x00 || 0x02 || PS(≥8) || 0x00（不含消息体） */
  public static readonly PKCS1_MIN_BLOCK_BYTES: number = 11;
  /** PKCS#1 v1.5 填充串 PS 最少字节数（规范要求 ≥ 8 个非零字节） */
  public static readonly PKCS1_MIN_PS_BYTES: number = 8;
  /** 密文不可解提示（客户端侧问题） */
  public static readonly DECRYPT_FAILED_MESSAGE: string = '密码解密失败，请刷新页面后重试';
  /** 私钥缺失/损坏提示（服务端配置问题） */
  public static readonly KEY_UNAVAILABLE_MESSAGE: string = '服务端密码解密密钥不可用';
}
