import os from 'node:os';
import cluster from 'node:cluster';

/**
 * 解析 CLUSTER_WORKERS 得到 worker 数：
 * - 未设置 / '1' / '0' / 负数 / 非数字 → 1（单进程，不启用 cluster，开发默认）
 * - 'auto' → CPU 核数
 * - N≥2 → N
 */
export function resolveWorkerCount(): number {
    const raw = process.env.CLUSTER_WORKERS;
    if (!raw) return 1;
    if (raw.trim().toLowerCase() === 'auto') return Math.max(1, os.cpus().length - 2);
    const n = parseInt(raw, 10);
    return Number.isNaN(n) || n <= 1 ? 1 : n;
}

/**
 * 当前进程的 worker 标识。
 * Node 内置 cluster 在 worker 进程设置 NODE_UNIQUE_ID，且 cluster.worker.id 可直接读取；
 * NODE_APP_INSTANCE 是 pm2 的约定，一并兼容；单进程/主进程返回 'primary'。
 */
export function getWorkerId(): string {
    return process.env.NODE_APP_INSTANCE
        ?? (cluster.isWorker && cluster.worker?.id != null ? String(cluster.worker.id) : 'primary');
}
