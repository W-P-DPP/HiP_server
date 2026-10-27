import './utils/env.ts';
import cluster from 'node:cluster';
import { resolveWorkerCount } from './utils/clusterConfig.ts';
import { startPrimary } from './utils/clusterPrimary.ts';
import { startWorker } from './utils/clusterWorker.ts';

async function main() {
  const workerCount = resolveWorkerCount();
  if (cluster.isPrimary && workerCount > 1) {
    // master：只 fork + 生命周期管理，不连 DB / 不 listen
    await startPrimary(workerCount);
  } else {
    // 单进程模式（CLUSTER_WORKERS 未设/≤1，开发默认）或 worker 进程
    await startWorker();
  }
}
void main();
