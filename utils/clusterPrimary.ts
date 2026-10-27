import cluster from 'node:cluster';
import crypto from 'node:crypto';
import {
    MASTER_SHUTDOWN_TIMEOUT_MS,
    WORKER_MAX_STARTUP_FAILURES,
    WORKER_RESTART_BASE_DELAY_MS,
    WORKER_RESTART_MAX_DELAY_MS,
} from './constant/ClusterConstants.ts';

/** 本次 cluster 启动唯一代次，注入子进程 env，供恢复逻辑区分「本次启动」与「worker 中途加入」 */
const generation = crypto.randomUUID();

let shuttingDown = false;
/** 未 ready 就退出的累计次数（连续启动失败熔断，防崩溃风暴） */
let startupFailures = 0;
const readyWorkers = new Set<number>();

/**
 * master 生命周期：fork worker、ready 握手、崩溃重启、信号转发、优雅退出。
 * master 不连 DB、不 listen——只做进程管理。
 */
export async function startPrimary(workerCount: number): Promise<void> {
    cluster.on('online', (worker) => {
        worker.on('message', (msg: { type?: string }) => {
            // ready 握手：区分「启动失败」与「运行期崩溃」
            if (msg?.type === 'ready') {
                readyWorkers.add(worker.id);
                startupFailures = 0;
            }
        });
    });

    cluster.on('exit', (worker, code, signal) => {
        if (shuttingDown) {
            // 优雅退出阶段：不重启，等全部 worker 退出后 master 退出
            if (Object.keys(cluster.workers ?? {}).length === 0) {
                console.log('[primary] 所有 worker 已退出');
                process.exit(0);
            }
            return;
        }
        const wasReady = readyWorkers.has(worker.id);
        readyWorkers.delete(worker.id);
        if (!wasReady) {
            // 启动失败：指数退避重试，连续失败熔断终止
            startupFailures += 1;
            if (startupFailures >= WORKER_MAX_STARTUP_FAILURES) {
                console.error('[primary] worker 连续启动失败，终止');
                process.exit(1);
            }
            const delay = Math.min(
                WORKER_RESTART_BASE_DELAY_MS * 2 ** (startupFailures - 1),
                WORKER_RESTART_MAX_DELAY_MS,
            );
            console.warn(`[primary] worker ${worker.id} 启动失败(code=${code} signal=${signal})，${delay}ms 后重试`);
            setTimeout(forkWorker, delay).unref();
            return;
        }
        // 运行期崩溃：立即重启
        console.warn(`[primary] worker ${worker.id} 崩溃(code=${code} signal=${signal})，立即重启`);
        forkWorker();
    });

    for (let i = 0; i < workerCount; i++) forkWorker();
    process.on('SIGTERM', () => shutdownPrimary('SIGTERM'));
    process.on('SIGINT', () => shutdownPrimary('SIGINT'));
}

function forkWorker(): void {
    cluster.fork({ CLUSTER_GENERATION: generation });
}

function shutdownPrimary(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[primary] 收到 ${reason}，通知全部 worker 排空退出`);
    for (const id of Object.keys(cluster.workers ?? {})) {
        cluster.workers[id]?.send({ type: 'shutdown' });
    }
    // 超时兜底：worker 未在限期内退出则强制
    setTimeout(() => {
        console.error('[primary] worker 退出超时，强制退出');
        process.exit(0);
    }, MASTER_SHUTDOWN_TIMEOUT_MS).unref();
}
