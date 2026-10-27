// utils/vlm/VlmHttpClient.ts
import path from 'node:path';
import fsp from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../Logger.ts';
import vlmConfig from './vlm.config.ts';
import type { Vlm } from '../../type/index.d.ts';

const logger = Logger.getInstance();

/** 连续失败次数上限，达到后 isUnhealthy() 为真（调用方可据此跳过本通道） */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 远端 job 终态（字段名与 services/vlm/http/jobs.py 的 snapshot 对齐） */
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);

/** 进度回调：(pct 0..1, ASCII stage, 中文提示) */
export type VlmProgressHandler = (pct: number, stage: string, message: string) => void;

interface RemoteJobSnapshot {
  job_id: string;
  state: string;
  progress: number;
  stage: string;
  mode?: string;
  attempts?: number;
  error?: string;
}

export interface VlmUnderstandOptions {
  /** 指令；缺省由调用方用 defaultPromptFor(mode) 兜底后传入 */
  prompt: string;
  /** 输出形态，必须与落库的任务一致 */
  mode: Vlm.Mode;
  /** 幂等键（容器侧 `client_job_id`）：重投不会重复消耗 GPU */
  clientJobId?: string;
  onProgress?: VlmProgressHandler;
}

/**
 * 带 HTTP 状态码的错误。
 *
 * `clientFault` 区分「这次请求本身有问题」（图片格式非法、过大 —— 换一条任务就好，
 * 不该把服务判为熔断）与「服务有问题」（5xx、job 丢失 —— 必须计入连续失败）。
 */
export class VlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly clientFault = false,
  ) {
    super(message);
    this.name = 'VlmHttpError';
  }
}

/**
 * 本地 Qwen3-VL 图片理解服务的 HTTP 客户端。
 *
 * 契约（服务端由 `services/vlm/` 单独交付，见其 README）：
 * - `GET  /readyz`                   无鉴权；模型就绪 200，加载中/未加载 503
 * - `POST /api/v1/jobs`               multipart：`image`(File) + `prompt` + `mode` + `client_job_id`
 * - `GET  /api/v1/jobs/{id}`          → `{ job_id, state, progress, stage, error? }`
 * - `GET  /api/v1/jobs/{id}/result`   → JSON（`{ mode, text, json, parse_ok, attempts, elapsed_ms }`）
 *
 * 刻意不用 `utils/Axios.ts`：那边有 5s 全局超时，且会把响应体 `JSON.stringify` 进日志 ——
 * 对二进制上传是灾难。这里用 Node 原生 fetch/FormData/File，与 `WhisperHttpClient` 同源。
 */
export class VlmHttpClient {
  private failures = 0;
  private lastProgress: { pct: number; stage: string } | null = null;

  constructor(
    private readonly cfg: {
      configured: boolean;
      baseUrl: string;
      apiToken: string;
      pollIntervalMs: number;
      jobTimeoutMs: number;
    } = vlmConfig,
  ) {}

  isUnhealthy(): boolean {
    return this.failures >= MAX_CONSECUTIVE_FAILURES;
  }

  getLastProgress(): { pct: number; stage: string } | null {
    return this.lastProgress;
  }

  /** `/readyz` 探活：可达且模型就绪才算 true（无鉴权；未加载时返回 503） */
  async ready(timeoutMs = 5_000): Promise<boolean> {
    if (!this.cfg.configured) return false;
    try {
      const res = await this.request('/readyz', {}, timeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 上传图片 → 轮询 → 取回结构化结果 */
  async understand(imageAbs: string, opts: VlmUnderstandOptions): Promise<Vlm.JobResult> {
    if (!this.cfg.configured) {
      throw new VlmHttpError(
        '图片理解未配置（需 VLM_MODE=remote 且设置 VLM_BASE_URL）',
        0,
        true,
      );
    }

    const jobId = await this.submit(imageAbs, opts);
    try {
      const final = await this.poll(jobId, opts.onProgress);
      if (final.state !== 'succeeded') {
        // 失败计数统一交给下方 catch 处理，避免同一失败被计两次
        throw new Error(final.error || `图片理解失败（state=${final.state}）`);
      }
      const result = await this.downloadResult(jobId);
      this.failures = 0;
      return result;
    } catch (err) {
      // 请求本身的问题（clientFault）不判熔断，否则一张格式非法的图片会让后续任务全进不来
      if (!(err instanceof VlmHttpError && err.clientFault)) {
        this.failures += 1;
      }
      throw err;
    }
  }

  private async submit(imageAbs: string, opts: VlmUnderstandOptions): Promise<string> {
    const buffer = await fsp.readFile(imageAbs);

    // 队列满（429）属暂时性背压，退避重试而不是让任务失败
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt += 1) {
      const form = new FormData();
      form.set('prompt', opts.prompt ?? '');
      form.set('mode', opts.mode);
      // 幂等键：服务端按 client_job_id 去重，重投直接返回原 job
      if (opts.clientJobId) form.set('client_job_id', opts.clientJobId);
      form.set(
        'image',
        new File([new Uint8Array(buffer)], path.basename(imageAbs), {
          type: 'application/octet-stream',
        }),
      );

      let res: Response;
      try {
        res = await this.request('/api/v1/jobs', { method: 'POST', body: form }, 120_000);
      } catch (err) {
        // 这里最常见的原因不是「服务报错」，而是容器没起来 / 地址写错 —— 必须把 errno 带出来
        throw new Error(`提交图片理解任务失败（${this.cfg.baseUrl}）：${describeNetworkError(err)}`);
      }

      if (res.status === 429) {
        if (attempt >= maxAttempts) {
          throw new Error(`图片理解服务队列持续繁忙，已重试 ${maxAttempts} 次`);
        }
        await sleep(Math.min(Math.max(this.cfg.pollIntervalMs, 200) * attempt, 10_000));
        continue;
      }
      if (!res.ok) {
        throw new VlmHttpError(
          await readError(res, '提交图片理解任务失败'),
          res.status,
          res.status < 500,
        );
      }

      const body = (await res.json()) as { job_id?: string };
      if (!body.job_id) throw new VlmHttpError('图片理解服务未返回 job_id', 502);
      logger.info(`[VlmHttpClient] 已提交任务 job=${body.job_id} image=${path.basename(imageAbs)}`);
      return body.job_id;
    }
  }

  private async poll(jobId: string, onProgress?: VlmProgressHandler): Promise<RemoteJobSnapshot> {
    const deadline = Date.now() + this.cfg.jobTimeoutMs;
    const delay = Math.max(300, Math.min(this.cfg.pollIntervalMs, 5_000));
    let consecutiveErrors = 0;
    let lastPct = -1;
    let lastStage = '';

    while (Date.now() < deadline) {
      let res: Response;
      try {
        res = await this.request(`/api/v1/jobs/${jobId}`, {}, 15_000);
      } catch (err) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) {
          throw new Error(
            `轮询图片理解服务连续失败（${consecutiveErrors} 次）：${describeNetworkError(err)}`,
          );
        }
        await sleep(delay);
        continue;
      }

      if (res.status === 404) {
        // 容器重启后丢失了 job 注册表 —— 明确报错，别让调用方干等到超时
        throw new VlmHttpError('图片理解服务不认识该任务（服务可能已重启），任务中断', 404);
      }
      if (!res.ok) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) {
          throw new VlmHttpError(await readError(res, '查询图片理解任务状态失败'), res.status);
        }
        await sleep(delay);
        continue;
      }

      consecutiveErrors = 0;
      const snap = (await res.json()) as RemoteJobSnapshot;

      // 单调过滤：stage 变化照传（阶段标签要准），pct 回退则丢弃
      if (snap.progress > lastPct || snap.stage !== lastStage) {
        lastPct = Math.max(lastPct, snap.progress);
        lastStage = snap.stage;
        this.lastProgress = { pct: lastPct, stage: lastStage };
        onProgress?.(lastPct, lastStage, `图片理解中 · ${lastStage}`);
      }

      if (TERMINAL_STATES.has(snap.state)) return snap;
      await sleep(delay);
    }

    throw new Error(
      `图片理解超时（${Math.round(this.cfg.jobTimeoutMs / 1000)}s），job=${jobId}`,
    );
  }

  /** 取回理解结果（结构化 JSON） */
  private async downloadResult(jobId: string): Promise<Vlm.JobResult> {
    const res = await this.request(`/api/v1/jobs/${jobId}/result`, {}, 120_000);
    if (!res.ok) {
      throw new VlmHttpError(await readError(res, '下载图片理解结果失败'), res.status);
    }
    return (await res.json()) as Vlm.JobResult;
  }

  private async request(pathname: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cfg.apiToken) headers.set('Authorization', `Bearer ${this.cfg.apiToken}`);
    return fetch(`${this.cfg.baseUrl}${pathname}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

/** 尽力从错误响应里取出服务端的可读消息（FastAPI 用 {detail}） */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail) {
      return `${fallback}：${body.detail}`;
    }
  } catch {
    // 响应体不是 JSON，用状态码兜底
  }
  return `${fallback}（HTTP ${res.status}）`;
}

/**
 * 把 fetch 的失败原因展开成可读文案（含 errno）。
 *
 * Node 的 fetch（undici）在**连接层**失败时只抛 `TypeError: fetch failed`，真正的原因
 * （`ECONNREFUSED` 容器没起 / `ENOTFOUND` 域名错 / 连接超时）挂在 `error.cause` 上。
 * 只取 `err.message` 会得到一句毫无信息量的「fetch failed」—— 排查时无法区分
 * 「容器没起来」与「地址配错了」，而这两者的处理方式完全不同。
 *
 * 用 `.cause` 链而不是只看第一层：undici 会把系统错误再包一层。
 * 用显式类型断言而不是 `Error.cause`：后者需要 ES2022 lib，这里不想为一个日志字符串
 * 去动 tsconfig 的 target/lib。
 */
function describeNetworkError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = err;

  while (cursor instanceof Error && !seen.has(cursor)) {
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    parts.push(typeof code === 'string' && code ? `${cursor.message} (${code})` : cursor.message);
    cursor = (cursor as { cause?: unknown }).cause;
  }

  return parts.length > 0 ? parts.join(' ← ') : String(err);
}

export { describeNetworkError };

let singleton: VlmHttpClient | null = null;

/** 进程内单例（保留失败计数与最近进度） */
export function getVlmClient(): VlmHttpClient {
  singleton ??= new VlmHttpClient();
  return singleton;
}

/** 供测试重置单例 */
export function resetVlmClient(): void {
  singleton = null;
}
