import './env.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { constants, createPrivateKey, privateDecrypt, type KeyObject } from 'node:crypto';
import { RsaConstants } from './constant/RsaConstants.ts';
import { Logger } from './Logger.ts';
import type { Rsa } from '../type/index.d.ts';

/** 私钥缓存：undefined=尚未加载，null=加载失败 */
let cachedPrivateKey: KeyObject | null | undefined;

/** 加载并缓存私钥；文件缺失或格式错误时记日志并返回 null（fail closed，不回退明文） */
function loadPrivateKey(): KeyObject | null {
  if (cachedPrivateKey !== undefined) return cachedPrivateKey;

  const keyPath = process.env.RSA_PRIVATE_KEY_PATH || RsaConstants.DEFAULT_PRIVATE_KEY_PATH;
  try {
    const pem = readFileSync(path.resolve(process.cwd(), keyPath), 'utf8');
    cachedPrivateKey = createPrivateKey(pem);
  } catch (err) {
    Logger.getInstance().error(
      `RSA 私钥加载失败（${keyPath}）：${err instanceof Error ? err.message : String(err)}`,
    );
    cachedPrivateKey = null;
  }
  return cachedPrivateKey;
}

/**
 * 手工做 PKCS#1 v1.5 去填充：EM = 0x00 || 0x02 || PS(≥8 字节非零) || 0x00 || M。
 *
 * 为什么不用 `padding: RSA_PKCS1_PADDING` 让 OpenSSL 直接去填充：Node 为修复
 * CVE-2023-46809（Marvin 时序侧信道）对 PKCS#1 v1.5 解密启用了**隐式拒绝** ——
 * 密文非法时不抛错，而是返回一段伪随机明文。那样「解密失败」无法判定，严格模式形同虚设
 * （注册接口会把乱码当成密码入库），因此改为取原始填充块自行校验。
 * 这里确实重新引入了「填充是否合法」这一位信息，但本场景密文是调用方自己刚输入的密码、
 * 且传输在 HTTPS 之上，外侧无秘密可被该 oracle 恢复，风险可忽略。
 */
function unpadPkcs1(em: Buffer): Buffer | null {
  if (em.length < RsaConstants.PKCS1_MIN_BLOCK_BYTES || em[0] !== 0x00 || em[1] !== 0x02) return null;

  let sep = 2;
  while (sep < em.length && em[sep] !== 0x00) sep++;

  // PS 至少 8 字节（分隔 0x00 的下标 ≥ 2+8），且必须真的找到分隔位
  if (sep < RsaConstants.PKCS1_MIN_PS_BYTES + 2 || sep >= em.length) return null;
  return em.subarray(sep + 1);
}

/**
 * 解密前端 JSEncrypt 提交的 base64 密码密文（PKCS#1 v1.5，与前端 encrypt() 对应）。
 * 前端公钥与后端私钥必须成对；解密失败一律不回退明文。
 */
export function decryptPassword(cipherText: string): Rsa.DecryptResult {
  const key = loadPrivateKey();
  if (!key) return { ok: false, reason: 'key_unavailable' };

  const cipher = Buffer.from(cipherText, 'base64');
  if (cipher.length !== RsaConstants.CIPHER_BYTE_LENGTH) return { ok: false, reason: 'invalid_cipher' };

  try {
    const em = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, cipher);
    const payload = unpadPkcs1(em);
    if (!payload) return { ok: false, reason: 'invalid_cipher' };

    // 前端提交的是 JS 字符串，必然能严格 UTF-8 解码；解不出说明密文不是本系统前端产出的
    const plain = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    return plain ? { ok: true, plain } : { ok: false, reason: 'invalid_cipher' };
  } catch {
    return { ok: false, reason: 'invalid_cipher' };
  }
}

/** 清空私钥缓存（切换 RSA_PRIVATE_KEY_PATH 后重新加载，供测试使用） */
export function resetRsaKeyCache(): void {
  cachedPrivateKey = undefined;
}
