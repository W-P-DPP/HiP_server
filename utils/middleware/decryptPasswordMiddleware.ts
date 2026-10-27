import type { NextFunction, Request, Response } from 'express';
import { decryptPassword } from '../rsa.ts';
import { HttpStatus } from '../constant/HttpStatus.ts';
import { RsaConstants } from '../constant/RsaConstants.ts';

/**
 * 解密请求体中的 password（前端 RSA 公钥加密的 base64 密文 → 明文）。
 * 仅挂在接收密码的路由上（登录 / 注册 / 修改用户 / 创建子用户）。
 * 字段缺失或空串直接放行，交由 controller 报「必填」；
 * 密文不可解 → 400，私钥不可用 → 500。严格模式：绝不回退明文。
 */
export function decryptPasswordMiddleware(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  const raw = body?.['password'];
  if (typeof raw !== 'string' || raw === '') {
    next();
    return;
  }

  const result = decryptPassword(raw);
  if (!result.ok) {
    if (result.reason === 'key_unavailable') {
      res.sendFail(RsaConstants.KEY_UNAVAILABLE_MESSAGE, HttpStatus.ERROR);
      return;
    }
    res.sendFail(RsaConstants.DECRYPT_FAILED_MESSAGE, HttpStatus.BAD_REQUEST);
    return;
  }

  if (body) body['password'] = result.plain;
  next();
}
