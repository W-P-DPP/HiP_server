import type { Request, Response, NextFunction } from 'express';
import { uuidManageService } from '../service/UuidManageService.ts';
import { UuidConstants } from '../constant/UuidConstants.ts';
import { HttpStatus } from '../constant/HttpStatus.ts';
import type { UuidManage } from '../../type/index.d.ts';

declare global {
  namespace Express {
    interface Request {
      /** 通过过期校验的 uuid session 记录 */
      uuidSession?: UuidManage.Record;
    }
  }
}

/** 取请求头单值（兼容 string | string[]） */
function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * uuid 过期校验中间件
 * 从请求头 hip-uuid 读取，只校验 session 是否已过期
 * 校验通过后把 session 记录挂到 req.uuidSession，供后续业务使用。
 */
export async function uuidValidateMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const uuid = headerValue(req, UuidConstants.UUID_HEADER);

  if (!uuid) {
    res.status(HttpStatus.BAD_REQUEST).sendFail(`缺少请求头 ${UuidConstants.UUID_HEADER}`, HttpStatus.BAD_REQUEST);
    return;
  }


  try {
    const record = await uuidManageService.status( uuid);
    if (!record) {
      res.status(HttpStatus.UNAUTHORIZED).sendFail('uuid 不存在或已过期', HttpStatus.UNAUTHORIZED);
      return;
    }
    req.uuidSession = record;
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'uuid 校验失败';
    res.status(HttpStatus.ERROR).sendFail(message, HttpStatus.ERROR);
  }
}
