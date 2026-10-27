import indexttsConfig from './indextts.config.ts';
import { IndexttsHttpClient } from './IndexttsHttpClient.ts';
import { IndexttsWorker } from './IndexttsWorker.ts';
import type { IndexttsEngine } from './IndexttsEngine.ts';

/**
 * 按 `INDEXTTS_MODE` 返回引擎实现（记忆化）。
 *
 * 取代历史上直接 `getIndexttsWorker()` 的调用点：调度器只认 `IndexttsEngine` 接口，
 * 于是「本地 spawn」与「远端 GPU 服务」可以互换而调度逻辑不动。
 *
 * 文件名带 Factory 后缀是刻意的：`IndexttsEngine.ts`（接口）与 `indexttsEngine.ts`
 * 仅大小写不同，在大小写不敏感的文件系统上会互相覆盖。
 */
let instance: IndexttsEngine | null = null;
let instanceKey = '';

export function getIndexttsEngine(cfg: typeof indexttsConfig = indexttsConfig): IndexttsEngine {
    const key = `${cfg.mode}|${cfg.baseUrl}|${cfg.installDir}|${cfg.modelDir}`;
    if (instance && instanceKey === key) return instance;
    if (instance) void instance.shutdown();
    instance = cfg.mode === 'remote' ? new IndexttsHttpClient(cfg) : new IndexttsWorker(cfg);
    instanceKey = key;
    return instance;
}

/** 仅供测试重置记忆化状态 */
export function resetIndexttsEngine(): void {
    if (instance) void instance.shutdown();
    instance = null;
    instanceKey = '';
}
