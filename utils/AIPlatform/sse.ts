import type { Response } from 'express';

/**
 * 初始化 SSE 响应头（绕过统一 ResultVO 信封）。
 * 调用后不可再走 res.json / res.sendSuccess，否则会破坏流式协议。
 */
export function initSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 关闭 nginx/反向代理缓冲，保证分片实时下发
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/** 写入一帧 SSE：`data: <json>\n\n`（客户端已断开时静默跳过，不抛错） */
export function writeSse(res: Response, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** 结束 SSE 流（幂等） */
export function endSse(res: Response): void {
  if (!res.writableEnded) res.end();
}
