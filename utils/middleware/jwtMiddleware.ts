import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { HttpStatus } from '../constant/HttpStatus.ts'
import { CacheConstants } from '../constant/CacheConstants.ts'
import { JwtConstants } from '../constant/JwtConstants.ts'
import RedisService from '../Redis.ts'
import { setCurrentUserId } from '../requestContext.ts'
import { UN_JWT } from '../constant/unJwtConstants.ts'

const JWT_SECRET = JwtConstants.SECRET

/** 免鉴权白名单路径前缀（unJwtConstants.ts 维护，匹配 req.path，即挂载点 /hip/api 之后的部分）。命中即跳过强制校验。 */
const JWT_WHITELIST_PREFIXES = Object.keys(UN_JWT)

export interface JwtPayload {
  [key: string]: any
}

declare global {
  namespace Express {
    interface Request {
      jwtPayload?: JwtPayload
    }
  }
}

/** 从 Cookie 头中解析指定 cookie（无 cookie-parser 依赖，手写解析） */
function getTokenFromCookie(req: Request): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    if (key === 'token') {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim())
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** SSO 校验：Redis 中该用户当前会话 token 必须与本次 token 一致 */
async function isCurrentSession(userId: string, token: string): Promise<boolean> {
  const key = `${CacheConstants.SSO_TOKEN_KEY}${userId}`
  const stored = await RedisService.getInstance().get(key)
  return stored === token
}

/** 把当前请求的 userid（JWT payload.id）写入请求上下文，供实体 createBy/updateBy 自动填充 */
function applyRequestUser(req: Request): void {
  const id = req.jwtPayload?.id
  setCurrentUserId(typeof id === 'string' ? id : undefined)
}

export async function jwtMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization']
  const headerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  const token = headerToken || getTokenFromCookie(req)

  // 白名单路径前缀免鉴权：提供 token 则 best-effort 解码填充 req.jwtPayload，从不拒绝（与 JWT_ENABLED=false 行为一致）
  const whitelisted = JWT_WHITELIST_PREFIXES.some((prefix) => req.path.startsWith(prefix))
  if (whitelisted) {
    if (token) {
      try {
        req.jwtPayload = jwt.verify(token, JWT_SECRET) as JwtPayload
      } catch {
        // 忽略无效 token，不设置 payload，直接放行
      }
    }
    applyRequestUser(req)
    return next()
  }

  if (JwtConstants.ENABLED) {
    // 启用：强制校验
    if (!token) {
      return res.status(HttpStatus.UNAUTHORIZED).sendFail('Missing or invalid Authorization header', HttpStatus.UNAUTHORIZED)
    }
    let payload: JwtPayload
    try {
      payload = jwt.verify(token, JWT_SECRET) as JwtPayload
    } catch {
      return res.status(HttpStatus.UNAUTHORIZED).sendFail('Invalid or expired token', HttpStatus.UNAUTHORIZED)
    }
    req.jwtPayload = payload

    // 单点登录：token 必须等于 Redis 中该用户当前有效会话 token（同账号新登录会使旧 token 失效）
    const userId = payload.id
    const isCurrent = typeof userId === 'string' ? await isCurrentSession(userId, token) : false
    if (!isCurrent) {
      return res.status(HttpStatus.UNAUTHORIZED).sendFail('登录已失效或已在其他设备登录，请重新登录', HttpStatus.UNAUTHORIZED)
    }
    applyRequestUser(req)
    return next()
  }

  // 未启用（开发模式）：best-effort 解码，提供 token 则填充 req.jwtPayload，从不拒绝
  if (token) {
    try {
      req.jwtPayload = jwt.verify(token, JWT_SECRET) as JwtPayload
    } catch {
      // 忽略无效 token，不设置 payload，直接放行
    }
  }
  applyRequestUser(req)
  next()
}

export function generateToken(payload: JwtPayload, expiresIn: number = JwtConstants.EXPIRES_IN): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn })
}
