/** 优雅退出排空钩子注册表：业务层注册排空回调，worker 关闭时统一等待 */

const hooks: Array<() => Promise<void>> = [];

/** 注册一个排空钩子（如等待任务队列结算），优雅退出时执行 */
export function registerShutdownHook(fn: () => Promise<void>): void {
    hooks.push(fn);
}

/** 执行全部已注册排空钩子；单个失败不阻断其余 */
export async function drainShutdownHooks(): Promise<void> {
    await Promise.allSettled(hooks.map((h) => h()));
}
