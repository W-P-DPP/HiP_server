// utils/middleware/bodyParserErrorMiddleware.ts
import type { ErrorRequestHandler } from 'express';
import { fail } from '../response.ts';
import { HttpStatus } from '../constant/HttpStatus.ts';

/**
 * 把 body-parser 的「请求体超限」翻成业务 400 信封。
 *
 * 超限错误默认冒到全局 ErrorLogger 就变成 500（Internal Server Error）—— 但请求过大不是服务端故障，
 * 让用户看到系统错误既误导又无法自查。与 aiDetect.router.ts 的 handleDetectUploadError 同思路，
 * 区别只是这里拦的是 body 解析错误而非 multer 上传错误。其余错误原样交回 next，走既有错误链路。
 *
 * 注意这里**不能**用 res.sendFail：解析失败时 Express 会跳过其后所有普通中间件（含 responseMiddleware
 * 与 RequestLogger），本请求根本到不了它们。故直接用 response.ts 的 fail() 构造同样的信封
 * （HTTP 200 + body.code），与 sendFail 的输出完全一致。
 */
export const bodyParserErrorMiddleware: ErrorRequestHandler = (err, _req, res, next) => {
  const parserError = err as { type?: string; status?: number };
  if (parserError.type === 'entity.too.large' || parserError.status === 413) {
    res.json(fail('请求体过大，请精简内容后重试', HttpStatus.BAD_REQUEST));
    return;
  }
  next(err);
};
