/**
 * 压力测试入口
 *
 * 使用方式：
 *   pnpm stress                     # 对运行中的服务做压测（默认 http://localhost:30010）
 *   pnpm stress --url http://...     # 自定义目标地址
 *   pnpm stress --scenario spike     # 指定场景：baseline | spike | soak
 *
 * 也可以内嵌启动服务后压测（不依赖外部进程）：
 *   pnpm stress:local
 */

import autocannon from 'autocannon';
import { createApp } from '../../app.ts';
import http from 'http';

// ─── CLI 参数解析 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (key: string, fallback: string) => {
  const idx = args.indexOf(key);
  return idx !== -1 && args[idx + 1] ? args[idx + 1]! : fallback;
};

const SCENARIO = getArg('--scenario', 'baseline') as 'baseline' | 'spike' | 'soak';
const EXTERNAL_URL = getArg('--url', '');

// ─── 压测场景配置 ─────────────────────────────────────────────────────────────
const SCENARIOS = {
  /** 基准测试：稳定并发，测吞吐量和响应时间基线 */
  baseline: {
    connections: 10,
    duration: 15,
    pipelining: 1,
  },
  /** 峰值测试：短时高并发，测系统承压能力 */
  spike: {
    connections: 100,
    duration: 10,
    pipelining: 5,
  },
  /** 浸泡测试：长时间低并发，测内存泄漏和资源稳定性 */
  soak: {
    connections: 5,
    duration: 60,
    pipelining: 1,
  },
} as const;

// ─── 压测请求配置 ─────────────────────────────────────────────────────────────
function buildRequests(token?: string): autocannon.Request[] {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return [
    { method: 'GET', path: '/api/getMenu', headers },
  ];
}

// ─── 结果打印 ─────────────────────────────────────────────────────────────────
function printResult(result: autocannon.Result) {
  const { requests, latency, throughput, errors, non2xx } = result;

  console.log('\n═══════════════════════ 压测结果 ═══════════════════════');
  console.log(`场景:      ${SCENARIO}`);
  console.log(`并发数:    ${SCENARIOS[SCENARIO].connections}`);
  console.log(`持续时间:  ${SCENARIOS[SCENARIO].duration}s`);
  console.log('─────────────────────────────────────────────────────────');
  console.log(`总请求数:  ${requests.total}`);
  console.log(`RPS:       ${requests.mean.toFixed(0)} req/s  (max: ${requests.max})`);
  console.log('─── 延迟 (ms) ────────────────────────────────────────────');
  console.log(`  平均:    ${latency.mean.toFixed(2)}`);
  console.log(`  P50:     ${latency.p50}`);
  console.log(`  P90:     ${latency.p90}`);
  console.log(`  P99:     ${latency.p99}`);
  console.log(`  最大:    ${latency.max}`);
  console.log('─── 吞吐量 ───────────────────────────────────────────────');
  console.log(`  平均:    ${(throughput.mean / 1024).toFixed(1)} KB/s`);
  console.log('─── 错误 ─────────────────────────────────────────────────');
  console.log(`  网络错误: ${errors}`);
  console.log(`  非 2xx:  ${non2xx}`);

  const ok = errors === 0 && non2xx === 0;
  console.log(`\n结论: ${ok ? '✅ 通过' : '❌ 存在错误，请检查服务'}`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
async function run() {
  const scenarioCfg = SCENARIOS[SCENARIO];
  const requests = buildRequests();

  if (EXTERNAL_URL) {
    // 对外部已运行的服务压测
    console.log(`\n▶ 压测外部服务: ${EXTERNAL_URL}  场景: ${SCENARIO}`);
    const result = await autocannon({
      url: EXTERNAL_URL,
      ...scenarioCfg,
      requests,
    });
    printResult(result);
    return;
  }

  // 内嵌启动服务，压测完毕自动关闭
  console.log(`\n▶ 内嵌启动服务进行压测  场景: ${SCENARIO}`);
  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;
  console.log(`  服务监听: ${url}`);

  try {
    const result = await autocannon({
      url,
      ...scenarioCfg,
      requests,
    });
    printResult(result);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

run().catch((err) => {
  console.error('压测异常:', err);
  process.exit(1);
});
