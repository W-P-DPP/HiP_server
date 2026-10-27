import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../Logger.ts';
import heygemConfig from './heygem.config.ts';
import {
  collectResult,
  copyCompleteResult,
  ensureMountLayout,
  resolveResultHostPath,
  stageFile,
  taskSubdir,
} from './heygemMount.ts';
import {
  HEYGEM_AUDIO_FILE_NAME,
  HEYGEM_MODEL_FILE_NAME,
} from '../constant/digitalHuman.ts';

const logger = Logger.getInstance();

/** duix 认为任务已完成的 status 取值 */
const DONE_STATUS = new Set<unknown>([2, '2', 'success', 'done', 'finish', 'completed', '200']);
/** duix 认为任务失败的 status 取值 */
const FAIL_STATUS = new Set<unknown>([3, '3', 'fail', 'failed', 'error', 'cancel', 'cancelled']);

/** 进度回调入参：pct 为 HeyGem 阶段内的局部占比 0..1，message 供直接展示 */
export interface HeygemProgress {
  pct: number;
  message: string;
}

export type HeygemProgressHandler = (progress: HeygemProgress) => void;

/** 供 `GET /engine/status` 观测的 duix 服务信息 */
export interface HeygemEngineInfo {
  baseUrl: string;
  reachable: boolean;
  error?: string;
}

/** 生成数字人视频的任务描述 */
export interface HeygemJobSpec {
  /** 16k mono 驱动音频的本地绝对路径 */
  audioPath: string;
  /** 参考视频的本地绝对路径（必须在挂载目录之外也可，由本客户端 stage 进挂载） */
  referenceVideoPath: string;
  /** 任务码，duix 以此关联提交与查询、并据此命名产物 */
  code: string;
  /** 产物 mp4 的落盘绝对路径 */
  outputPath: string;
}

/**
 * 带 HTTP 状态码的错误，`clientFault` 区分「这次请求本身有问题」（参考视频非法 —— 换个任务就好）
 * 与「服务有问题」（5xx / 容器挂了 —— 必须计入连续失败）。
 */
class HeygemHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly clientFault = false,
  ) {
    super(message);
    this.name = 'HeygemHttpError';
  }
}

/** duix `/easy/query` 归一化后的字段 */
interface HeygemQueryInfo {
  apiCode: unknown;
  msg: string;
  status: unknown;
  progress: unknown;
  result: unknown;
  raw: Record<string, unknown>;
}

/** duix 的查询响应常把真实字段嵌在 data 下，这里统一摊平 */
function unwrapQuery(raw: Record<string, unknown>): HeygemQueryInfo {
  const inner = (typeof raw.data === 'object' && raw.data !== null ? raw.data : {}) as Record<string, unknown>;
  // 失败响应里顶层 msg 是空串、真实原因在 data.msg 下，因此必须按「非空」回退：
  // 用 ?? 会被空串短路，落得 msg 为空，失败原因（如「三次获取音频时长失败」）全都丢掉
  const msg = String(raw.msg || inner.msg || '').trim();
  return {
    apiCode: raw.code,
    msg,
    status: inner.status ?? raw.status,
    progress: inner.progress ?? raw.progress,
    result: inner.result ?? inner.video_path ?? inner.video_url ?? raw.result ?? raw.video_path ?? raw.video_url,
    raw,
  };
}

/** 状态码 → 人类可读标签 */
function statusLabel(status: unknown, msg: string): string {
  if (msg) return msg;
  if (status === null || status === undefined || status === '') return '合成中';
  const mapping: Record<number, string> = { 0: '排队中', 1: '合成中', 2: '完成', 3: '失败' };
  const n = Number(status);
  return Number.isFinite(n) && mapping[n] !== undefined ? (mapping[n] as string) : String(status);
}

/** duix 完成任务后常清理任务索引并返回 10004，此时产物已在 temp/ 下 */
function isMissingTask(apiCode: unknown, msg: string): boolean {
  if (apiCode === 10004 || apiCode === '10004') return true;
  return ['不存在', 'not exist', 'not found', 'NotFound'].some((k) => msg.includes(k));
}

/**
 * duix 读不到素材时的失败提示。
 *
 * duix 通过共享目录取音频/参考视频，取不到时 ffprobe 拿不到流信息，重试 3 次后报
 * 「三次获取音频时长失败」。九成是 Node 侧 HEYGEM_MOUNT_DIR 与 duix 容器挂载点不是
 * 同一份宿主机数据（典型：app 与 duix 从不同检出目录启动）。这里补一句定位提示，
 * 免得只看到一句干巴巴的 duix 原始报文。
 */
function unreadableMaterialHint(msg: string): string {
  if (/获取音频时长|audio duration|audio format|No such file|cannot open/i.test(msg)) {
    return (
      '（duix 读不到素材：请确认 Node 侧 HEYGEM_MOUNT_DIR 与 duix 容器挂载的是同一份数据，' +
      '即两份 compose 共享同一个命名卷/宿主机目录）'
    );
  }
  return '';
}

function isFailed(status: unknown, msg: string, apiCode: unknown): boolean {
  if (isMissingTask(apiCode, msg)) return true;
  const lower = msg.toLowerCase();
  if (['失败', 'fail', 'error', '异常', 'timeout'].some((k) => lower.includes(k))) return true;
  if (FAIL_STATUS.has(status)) return true;
  return ['fail', 'error', 'cancel'].some((m) => String(status).toLowerCase().includes(m));
}

function isDone(status: unknown, result: unknown): boolean {
  if (DONE_STATUS.has(status)) return true;
  const text = String(status).toLowerCase();
  if (['success', 'done', 'finish', 'completed'].some((m) => text.includes(m))) return true;
  return typeof result === 'string' && result.endsWith('.mp4');
}

/**
 * HeyGem / Duix-Avatar 本地 HTTP 客户端（默认 8383）。
 *
 * 与 HTTP 上传类服务不同，duix 通过**共享 bind-mount** 取素材：本客户端把音频与参考视频
 * 拷进挂载目录后，上行的是**容器内路径**；产物同理从挂载目录回收。因此 `HEYGEM_MOUNT_DIR`
 * 必须与 duix 容器挂载的宿主机目录一致，否则任务会立刻失败。
 *
 * 用原生 fetch（不用 utils/Axios.ts：其 5s 全局超时对长轮询不适用，且会把响应体字符串化进日志）。
 */
export class HeygemClient {
  readonly kind = 'remote' as const;

  /** 连续失败计数，达到 maxCrashes 后 isUnhealthy() 为真 */
  private failures = 0;

  /** 健康探测缓存（避免每个调度 tick 都打一次网络） */
  private reachable = false;
  private probeError = '';
  private probedAt = 0;

  /** 最近一次 HeyGem 阶段进度，供 /engine/status 观测 */
  private lastProgress: HeygemProgress | null = null;

  // ---- 状态查询 ----

  isReady(): boolean {
    return this.reachable;
  }

  isUnhealthy(): boolean {
    return this.failures >= heygemConfig.maxCrashes;
  }

  /** duix 进程不在本进程树下 */
  getPid(): number | null {
    return null;
  }

  getLastProgress(): HeygemProgress | null {
    return this.lastProgress;
  }

  /**
   * 服务可达时才领取任务。
   *
   * 容器重启期间返回 false，让 Mongo 里的任务留在 pending（等容器恢复），而不是领出来立刻烧成
   * failed。判据是「可达」而非「就绪」—— duix 没有模型加载态，能响应即可接单。
   */
  async canAcceptWork(): Promise<boolean> {
    if (this.isUnhealthy()) return false;
    await this.probeIfStale();
    return this.reachable;
  }

  /** 跳过缓存直接探测一次，供 /engine/status 使用 */
  async getEngineInfo(): Promise<HeygemEngineInfo> {
    await this.probeIfStale(true);
    return {
      baseUrl: heygemConfig.baseUrl,
      reachable: this.reachable,
      ...(this.probeError ? { error: this.probeError } : {}),
    };
  }

  /**
   * 探测存活。用查询接口做探针（duix 未提供独立 health 路由）：
   * 任何 HTTP 响应都算「可达」（即便是 404/500）—— 只有连不上才是不可达。
   */
  private async probeIfStale(force = false): Promise<void> {
    const ttl = Math.min(heygemConfig.pollIntervalMs * 4, 10_000);
    if (!force && Date.now() - this.probedAt < ttl) return;
    this.probedAt = Date.now();
    try {
      await fetch(`${heygemConfig.baseUrl}/easy/query?code=health_probe`, {
        method: 'GET',
        signal: AbortSignal.timeout(heygemConfig.healthTimeoutMs),
      });
      this.reachable = true;
      this.probeError = '';
    } catch (err) {
      this.reachable = false;
      this.probeError = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- 合成 ----

  /**
   * 执行一次数字人合成：stage 素材 → 提交 → 轮询 → 回收产物。
   * @returns 产物 mp4 的本地绝对路径（即 spec.outputPath）
   */
  async generateVideo(spec: HeygemJobSpec, onProgress?: HeygemProgressHandler): Promise<string> {
    ensureMountLayout();
    const subdir = taskSubdir(spec.code);
    const audio = stageFile(spec.audioPath, subdir, HEYGEM_AUDIO_FILE_NAME);
    const model = stageFile(spec.referenceVideoPath, subdir, HEYGEM_MODEL_FILE_NAME);

    try {
      await this.submit(spec.code, audio.containerPath, model.containerPath);
      const result = await this.poll(spec.code, spec.outputPath, onProgress);
      this.failures = 0;
      return result;
    } catch (err) {
      // 请求本身的问题（clientFault）不把服务判为熔断，否则一条参考视频不合规的任务
      // 就会让后续所有任务都进不来
      if (!(err instanceof HeygemHttpError && err.clientFault)) {
        this.failures += 1;
      }
      throw err;
    }
  }

  /** 提交任务；素材已在挂载目录内，上行容器路径 */
  private async submit(code: string, audioUrl: string, videoUrl: string): Promise<void> {
    const payload = {
      audio_url: audioUrl,
      video_url: videoUrl,
      code,
      chaofen: heygemConfig.chaofen,
      watermark_switch: heygemConfig.watermarkSwitch,
      pn: heygemConfig.pn,
    };

    let res: Response;
    try {
      res = await fetch(`${heygemConfig.baseUrl}/easy/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HeygemHttpError(`提交数字人任务失败（${heygemConfig.baseUrl}）：${message}`, 502);
    }

    if (!res.ok) {
      throw new HeygemHttpError(
        await readError(res, '提交数字人任务失败'),
        res.status,
        res.status < 500,
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // 空响应体也视为已受理，交由轮询判定
    }
    if (body.success === false) {
      throw new HeygemHttpError(`HeyGem 提交失败：${JSON.stringify(body)}`, 502);
    }
    logger.info(`[Heygem] 已提交任务 code=${code} audio=${audioUrl} video=${videoUrl}`);
  }

  /** 轮询任务状态；成功时把产物拷到 spec.outputPath 并返回 */
  private async poll(
    code: string,
    destAbs: string,
    onProgress?: HeygemProgressHandler,
  ): Promise<string> {
    const deadline = Date.now() + heygemConfig.timeoutSec * 1000;
    const delay = Math.max(300, heygemConfig.pollIntervalSec * 1000);
    let seenRunning = false;
    let missingStreak = 0;

    const report = (pct: number, message: string): void => {
      const clamped = Math.max(0, Math.min(1, pct));
      this.lastProgress = { pct: clamped, message };
      onProgress?.(this.lastProgress);
    };

    while (Date.now() < deadline) {
      const info = await this.query(code);
      const label = statusLabel(info.status, info.msg);

      // 进度可能给 0–1 或 0–100，统一归一到 0–1
      let pct = 0.2;
      if (typeof info.progress === 'number' && Number.isFinite(info.progress)) {
        const p = info.progress > 1 ? info.progress / 100 : info.progress;
        pct = Math.max(0, Math.min(1, p));
      } else if (info.status === 1 || info.status === '1') {
        pct = 0.35;
      }
      report(pct, `HeyGem · ${label}`);

      const running =
        info.status === 0 || info.status === '0' || info.status === 1 || info.status === '1' ||
        (typeof info.progress === 'number' && info.progress > 0);
      if (running) {
        seenRunning = true;
        missingStreak = 0;
      }

      // 先扫盘：duix 完成（甚至清理索引）后产物已在 temp/ 下，这是最可靠的成功信号
      const collected = await collectResult(code, destAbs);
      if (collected) {
        report(1, 'HeyGem · 完成');
        return collected;
      }

      if (isMissingTask(info.apiCode, info.msg)) {
        missingStreak += 1;
        // 刚提交时查询可能短暂返回 10004，容忍几次
        if (seenRunning || missingStreak >= 5) {
          const late = await collectResult(code, destAbs);
          if (late) {
            report(1, 'HeyGem · 完成');
            return late;
          }
          throw new HeygemHttpError(
            'HeyGem 任务不存在或已失败（常见原因：容器挂载目录与 HEYGEM_MOUNT_DIR 不一致，' +
              `容器读不到音频/视频）。详情：${JSON.stringify(info.raw)}`,
            502,
          );
        }
        await sleep(delay);
        continue;
      }

      if (isFailed(info.status, info.msg, info.apiCode)) {
        throw new HeygemHttpError(
          `HeyGem 合成失败${unreadableMaterialHint(info.msg)}：${JSON.stringify(info.raw)}`,
          502,
        );
      }

      if (isDone(info.status, info.result)) {
        if (typeof info.result === 'string') {
          const host = resolveResultHostPath(info.result);
          if (host) {
            const copied = await copyCompleteResult(host, destAbs);
            if (copied) {
              report(1, 'HeyGem · 完成');
              return copied;
            }
          }
        }
        const fallback = await collectResult(code, destAbs);
        if (fallback) {
          report(1, 'HeyGem · 完成');
          return fallback;
        }
      }

      await sleep(delay);
    }

    // 超时前最后一搏：可能刚写完
    const late = await collectResult(code, destAbs);
    if (late) {
      report(1, 'HeyGem · 完成');
      return late;
    }
    throw new HeygemHttpError(
      `HeyGem 合成超时（>${heygemConfig.timeoutSec}s），code=${code}`,
      504,
    );
  }

  /** 查询一次任务状态（网络抖动时重试，连续失败才抛） */
  private async query(code: string): Promise<HeygemQueryInfo> {
    let consecutiveErrors = 0;
    for (;;) {
      try {
        const res = await fetch(`${heygemConfig.baseUrl}/easy/query?code=${encodeURIComponent(code)}`, {
          method: 'GET',
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          throw new HeygemHttpError(await readError(res, '查询数字人任务状态失败'), res.status);
        }
        const body = (await res.json()) as Record<string, unknown>;
        return unwrapQuery(body);
      } catch (err) {
        consecutiveErrors += 1;
        if (err instanceof HeygemHttpError && err.clientFault) throw err;
        if (consecutiveErrors >= 5) {
          const message = err instanceof Error ? err.message : String(err);
          throw new HeygemHttpError(`轮询 HeyGem 连续失败（${consecutiveErrors} 次）：${message}`, 502);
        }
        await sleep(Math.max(300, heygemConfig.pollIntervalSec * 1000));
      }
    }
  }
}

/** 尽力从错误响应里取出服务端的可读消息 */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (text) return `${fallback}：${text.slice(0, 500)}`;
  } catch {
    // 响应体不可读，用状态码兜底
  }
  return `${fallback}（HTTP ${res.status}）`;
}

/** 记忆化单例（配置来自 env，进程内只需一个客户端） */
let instance: HeygemClient | null = null;

export function getHeygemClient(): HeygemClient {
  if (!instance) instance = new HeygemClient();
  return instance;
}

/** 仅供测试重置记忆化状态 */
export function resetHeygemClient(): void {
  instance = null;
}

export { HeygemHttpError };
