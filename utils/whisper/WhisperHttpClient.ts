// utils/whisper/WhisperHttpClient.ts
import path from 'node:path';
import fsp from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../Logger.ts';
import whisperConfig, { type WhisperConfig } from './whisper.config.ts';
import type { AsrProgressHandler } from '../asr/types.ts';

const logger = Logger.getInstance();

/** 连续失败次数上限，达到后 isUnhealthy() 为真（调用方可据此跳过本通道） */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 远端 job 终态（字段名与 services/whisper/http/jobs.py 的 snapshot 对齐） */
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);

interface RemoteJobSnapshot {
  job_id: string;
  state: string;
  progress: number;
  stage: string;
  error?: string;
}

/**
 * 带 HTTP 状态码的错误。
 *
 * `clientFault` 区分「这次请求本身有问题」（音频格式非法、过大 —— 换一条任务就好，
 * 不该把服务判为熔断）与「服务有问题」（5xx、job 丢失 —— 必须计入连续失败）。
 */
export class WhisperHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly clientFault = false,
  ) {
    super(message);
    this.name = 'WhisperHttpError';
  }
}

export interface WhisperTranscribeOptions {
  language?: string;
  /** 幂等键（服务端 `client_job_id`）：重投不会重复消耗 GPU */
  clientJobId?: string;
  onProgress?: AsrProgressHandler;
}

/**
 * 本地 Whisper 服务的 HTTP 客户端（`auto` ASR 链的优先通道）。
 *
 * 契约（服务端由 `services/whisper/` 单独交付，见其 README）：
 * - `GET  /readyz`                  无鉴权；模型就绪 200，加载中 503
 * - `POST /api/v1/jobs`             multipart：`audio`(File) + `language` → `{ job_id }`
 * - `GET  /api/v1/jobs/{id}`        → `{ job_id, state, progress, stage, error? }`
 * - `GET  /api/v1/jobs/{id}/result` → 纯文本 SRT（text/plain）
 *
 * 刻意不用 `utils/Axios.ts`：那边有 5s 全局超时，且会把响应体 `JSON.stringify` 进日志 ——
 * 对二进制上传是灾难。这里用 Node 22 原生 fetch/FormData/File，与 `IndexttsHttpClient` 同源。
 */
export class WhisperHttpClient {
  private failures = 0;
  private lastProgress: { pct: number; stage: string } | null = null;

  constructor(private readonly cfg: WhisperConfig = whisperConfig) {}

  isUnhealthy(): boolean {
    return this.failures >= MAX_CONSECUTIVE_FAILURES;
  }

  getLastProgress(): { pct: number; stage: string } | null {
    return this.lastProgress;
  }

  /** `/readyz` 探活：可达且模型就绪才算 true（无鉴权，加载中会返回 503） */
  async ready(timeoutMs = 5_000): Promise<boolean> {
    if (!this.cfg.enabled) return false;
    try {
      const res = await this.request('/readyz', {}, timeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 上传音频 → 轮询 → 取回 SRT 文本 */
  async transcribe(
    audioAbs: string,
    opts: WhisperTranscribeOptions = {},
  ): Promise<{ srt: string }> {
    if (!this.cfg.enabled) {
      throw new WhisperHttpError(
        'Whisper 未配置（需 WHISPER_MODE=remote 且设置 WHISPER_BASE_URL）',
        0,
        true,
      );
    }

    const jobId = await this.submit(audioAbs, opts);
    try {
      const final = await this.poll(jobId, opts.onProgress);
      if (final.state !== 'succeeded') {
        // 失败计数统一交给下方 catch 处理，避免同一失败被计两次
        throw new Error(final.error || `Whisper 转写失败（state=${final.state}）`);
      }
      const srt = await this.download(jobId);
      this.failures = 0;
      return { srt };
    } catch (err) {
      // 请求本身的问题（clientFault）不判熔断，否则一条格式非法的音频会让后续任务全进不来
      if (!(err instanceof WhisperHttpError && err.clientFault)) {
        this.failures += 1;
      }
      throw err;
    }
  }

  private async submit(audioAbs: string, opts: WhisperTranscribeOptions): Promise<string> {
    const buffer = await fsp.readFile(audioAbs);
    const language = resolveWhisperLanguage(opts.language, this.cfg.language);

    // 队列满（429）属暂时性背压，退避重试而不是让任务失败
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt += 1) {
      const form = new FormData();
      form.set('language', language);
      // 幂等键：服务端按 client_job_id 去重，重投直接返回原 job
      if (opts.clientJobId) form.set('client_job_id', opts.clientJobId);
      form.set(
        'audio',
        new File([new Uint8Array(buffer)], path.basename(audioAbs), {
          type: 'application/octet-stream',
        }),
      );

      let res: Response;
      try {
        res = await this.request('/api/v1/jobs', { method: 'POST', body: form }, 120_000);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`提交 Whisper 转写任务失败（${this.cfg.baseUrl}）：${message}`);
      }

      if (res.status === 429) {
        if (attempt >= maxAttempts) {
          throw new Error(`Whisper 服务队列持续繁忙，已重试 ${maxAttempts} 次`);
        }
        await sleep(Math.min(Math.max(this.cfg.pollIntervalMs, 200) * attempt, 10_000));
        continue;
      }
      if (!res.ok) {
        throw new WhisperHttpError(
          await readError(res, '提交 Whisper 转写任务失败'),
          res.status,
          res.status < 500,
        );
      }

      const body = (await res.json()) as { job_id?: string };
      if (!body.job_id) throw new WhisperHttpError('Whisper 服务未返回 job_id', 502);
      logger.info(`[WhisperHttpClient] 已提交任务 job=${body.job_id} audio=${path.basename(audioAbs)}`);
      return body.job_id;
    }
  }

  private async poll(
    jobId: string,
    onProgress?: AsrProgressHandler,
  ): Promise<RemoteJobSnapshot> {
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
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`轮询 Whisper 服务连续失败（${consecutiveErrors} 次）：${message}`);
        }
        await sleep(delay);
        continue;
      }

      if (res.status === 404) {
        // 服务重启后丢失了 job 注册表 —— 明确报错，别让调用方干等到超时
        throw new WhisperHttpError('Whisper 服务不认识该任务（服务可能已重启），任务中断', 404);
      }
      if (!res.ok) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) {
          throw new WhisperHttpError(await readError(res, '查询 Whisper 任务状态失败'), res.status);
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
        onProgress?.(lastPct, 'asr', `Whisper 识别中${snap.stage ? ` · ${snap.stage}` : ''}`);
      }

      if (TERMINAL_STATES.has(snap.state)) return snap;
      await sleep(delay);
    }

    throw new Error(
      `Whisper 转写超时（${Math.round(this.cfg.jobTimeoutMs / 1000)}s），job=${jobId}`,
    );
  }

  /** 取回转写结果（SRT 纯文本） */
  private async download(jobId: string): Promise<string> {
    const res = await this.request(`/api/v1/jobs/${jobId}/result`, {}, 120_000);
    if (!res.ok) {
      throw new WhisperHttpError(await readError(res, '下载 Whisper 转写结果失败'), res.status);
    }
    const srt = await res.text();
    if (!srt.trim()) throw new WhisperHttpError('Whisper 转写结果为空', 502);
    return srt;
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

/** 讯飞口径的 autodialect 对 Whisper 无意义，回落到客户端配置的默认语种 */
export function resolveWhisperLanguage(requested: string | undefined, fallback: string): string {
  const value = (requested ?? '').trim();
  if (!value || value.toLowerCase() === 'autodialect') return fallback;
  return value;
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

let singleton: WhisperHttpClient | null = null;

/** 进程内单例（保留失败计数与最近进度） */
export function getWhisperClient(): WhisperHttpClient {
  singleton ??= new WhisperHttpClient();
  return singleton;
}

/** 供测试重置单例 */
export function resetWhisperClient(): void {
  singleton = null;
}
