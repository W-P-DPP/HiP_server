// utils/scenedetect/ScenedetectHttpClient.ts
/**
 * 独立部署的 PySceneDetect 场景切分服务的 HTTP 客户端。
 *
 * 契约（服务端由 `services/scenedetect/` 交付，见其 README）：
 * - `GET  /healthz`            无鉴权；进程存活恒 200
 * - `GET  /readyz`             无鉴权；就绪恒 200
 * - `POST /api/v1/detect`      Bearer；JSON 入参 → 与检测脚本 stdout 同构的 JSON
 *
 * 一次检测可能长达数分钟（逐帧解码），因此是**同步长请求**（非 job 队列），
 * 请求超时走上层传入的 SCENEDETECT_TIMEOUT_MS。
 *
 * 刻意不用 `utils/Axios.ts`：那边有 5s 全局超时且会把响应体 JSON.stringify 进日志。
 * 这里用 Node 原生 fetch，与 VlmHttpClient / WhisperHttpClient 同源。
 */
import { Logger } from '../Logger.ts';
import scenedetectConfig, { type ScenedetectConfig } from './scenedetect.config.ts';
import { normalizeDetectPayload, resolveDetector } from './normalize.ts';
import type { SceneDetect } from '../../type/index.d.ts';

const logger = Logger.getInstance();

/** 连续失败次数上限，达到后 isUnhealthy() 为真（调用方可据此跳过本通道） */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 带 HTTP 状态码的错误。
 *
 * `clientFault` 区分「这次请求本身有问题」（视频路径非法、参数错 —— 换一条任务就好，
 * 不该把服务判为熔断）与「服务有问题」（5xx、不可达 —— 必须计入连续失败）。
 */
export class ScenedetectHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly clientFault = false,
  ) {
    super(message);
    this.name = 'ScenedetectHttpError';
  }
}

/** 组装请求体；仅显式给出的选项才带上，其余交给服务/脚本自身的缺省值 */
const buildBody = (inputAbs: string, options: SceneDetect.DetectOptions): SceneDetect.DetectRequest => {
  const body: SceneDetect.DetectRequest = {
    input: inputAbs,
    detector: resolveDetector(options.detector),
  };
  if (typeof options.threshold === 'number' && Number.isFinite(options.threshold)) {
    body.threshold = options.threshold;
  }
  if (typeof options.minSceneLenSec === 'number' && Number.isFinite(options.minSceneLenSec)) {
    body.min_scene_len = options.minSceneLenSec;
  }
  if (typeof options.downscale === 'number' && Number.isFinite(options.downscale)) {
    body.downscale = Math.trunc(options.downscale);
  }
  if (typeof options.frameSkip === 'number' && Number.isFinite(options.frameSkip) && options.frameSkip > 0) {
    body.frame_skip = Math.trunc(options.frameSkip);
  }
  return body;
};

/** 判定 fetch 失败是否来自 AbortSignal.timeout（Node 抛 name=TimeoutError 的 DOMException） */
const isTimeoutError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
};

export class ScenedetectHttpClient {
  private failures = 0;

  constructor(private readonly cfg: ScenedetectConfig = scenedetectConfig) {}

  isUnhealthy(): boolean {
    return this.failures >= MAX_CONSECUTIVE_FAILURES;
  }

  /** 超时：入参 > 配置（SCENEDETECT_TIMEOUT_MS）；非法值一律回退，避免 NaN 让定时器立刻触发 */
  private resolveTimeout(override?: number): number {
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
    return this.cfg.timeoutMs;
  }

  /** `/readyz` 探活：可达且服务就绪才算 true（无鉴权；任何异常一律返回 false，不抛） */
  async ready(timeoutMs = 5_000): Promise<boolean> {
    if (!this.cfg.enabled || !this.cfg.baseUrl) return false;
    try {
      const res = await this.request('/readyz', {}, timeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 提交一次场景切分，返回与本地子进程路径完全一致的 `SceneDetect.Result` */
  async detect(inputAbs: string, options: SceneDetect.DetectOptions = {}): Promise<SceneDetect.Result> {
    if (!this.cfg.enabled || !this.cfg.baseUrl) {
      throw new ScenedetectHttpError(
        '场景检测服务未配置（需设置 SCENEDETECT_BASE_URL）',
        0,
        true,
      );
    }

    const timeoutMs = this.resolveTimeout(options.timeoutMs);
    logger.info(`[ScenedetectHttpClient] 启动检测：${this.cfg.baseUrl}/api/v1/detect input=${inputAbs}`);

    let res: Response;
    try {
      res = await this.request(
        '/api/v1/detect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody(inputAbs, options)),
        },
        timeoutMs,
      );
    } catch (err) {
      this.failures += 1;
      if (isTimeoutError(err)) {
        throw new Error(`场景检测超时（${timeoutMs}ms）：${inputAbs}`);
      }
      throw new Error(
        `场景检测服务不可达（${this.cfg.baseUrl}）：${describeNetworkError(err)}`,
      );
    }

    try {
      if (!res.ok) {
        throw new ScenedetectHttpError(
          await readError(res, '场景检测请求失败'),
          res.status,
          res.status < 500,
        );
      }

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        const preview = text.trim().slice(0, 500);
        throw new Error(`场景检测未返回可解析的 JSON：${preview || '(空输出)'}`);
      }

      const result = normalizeDetectPayload(parsed);
      this.failures = 0;
      return result;
    } catch (err) {
      // 请求本身的问题（clientFault）不判熔断，否则一条路径非法的视频会让后续任务全进不来
      if (!(err instanceof ScenedetectHttpError && err.clientFault)) {
        this.failures += 1;
      }
      throw err;
    }
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
 * （ECONNREFUSED 容器没起 / ENOTFOUND 域名错）挂在 `error.cause` 上；只取 message 无法区分。
 * 与 VlmHttpClient.describeNetworkError 同实现（各 client 自带一份，见其注释）。
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

let singleton: ScenedetectHttpClient | null = null;

/** 进程内单例（保留失败计数） */
export function getScenedetectClient(): ScenedetectHttpClient {
  singleton ??= new ScenedetectHttpClient();
  return singleton;
}

/** 供测试重置单例 */
export function resetScenedetectClient(): void {
  singleton = null;
}
