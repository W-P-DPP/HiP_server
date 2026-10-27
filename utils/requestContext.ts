import { AsyncLocalStorage } from 'node:async_hooks';

/** 单请求上下文：存放当前调用方 userId（来自 JWT，可为空） */
interface RequestContext {
  userId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

/** 每个请求一个独立 store，fn 内（含异步延续）都可读 */
export function runWithRequestContext<T>(fn: () => T): T {
  return als.run({}, fn);
}

/** 系统/后台写入隔离：以空 store（无 userId）运行，避免后台写继承发起请求的用户身份。
 *  用于第三方素材下载入库等“系统级”写入，保证实体 createBy 不被误填为触发者。 */
export function runIsolatedContext<T>(fn: () => T): T {
  return als.run({}, fn);
}

/** 写入当前请求上下文 userId；无上下文（非 HTTP 入口/测试）时静默 no-op */
export function setCurrentUserId(userId?: string): void {
  const store = als.getStore();
  if (store) store.userId = userId;
}

/** 读取当前请求上下文 userId；无上下文或未设置时 undefined */
export function getCurrentUserId(): string | undefined {
  return als.getStore()?.userId;
}
