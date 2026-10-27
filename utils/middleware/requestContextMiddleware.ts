import type { Request, Response, NextFunction } from 'express';
import { runWithRequestContext } from '../requestContext.ts';

/** 全局挂载：为每个请求建立独立 ALS 上下文，供 createBy/updateBy 自动填充 */
export function requestContextMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  runWithRequestContext(() => next());
}
