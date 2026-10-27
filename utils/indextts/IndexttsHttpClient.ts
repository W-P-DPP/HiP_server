import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../Logger.ts';
import indexttsConfig from './indextts.config.ts';
import type { IndexttsEngine, IndexttsEngineInfo } from './IndexttsEngine.ts';
import type { IndexttsJobSpec, IndexttsProgress, IndexttsProgressHandler } from './IndexttsWorker.ts';

const logger = Logger.getInstance();

/** 远端 job 状态（字段名与 services/indextts/http/jobs.py 的 snapshot 对齐） */
interface RemoteJobSnapshot {
    job_id: string;
    state: string;
    progress: number;
    stage: string;
    segCur?: number | null;
    segTotal?: number | null;
    audioSec?: number | null;
    error?: string;
    result?: { bytes?: number; sha256?: string };
}

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);

/**
 * 带 HTTP 状态码的错误。
 *
 * `clientFault` 区分「这次请求本身有问题」（文案超长、参考音非法 —— 换个任务就好了，
 * 不该把整个引擎判为熔断）与「服务有问题」（5xx、job 丢失 —— 必须计入连续失败）。
 */
class IndexttsHttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly clientFault = false,
    ) {
        super(message);
        this.name = 'IndexttsHttpError';
    }
}

/**
 * 独立 GPU 推理服务的 HTTP 客户端。
 *
 * 契约刻意与 `IndexttsWorker` 完全一致：**`run()` 返回本地 wav 绝对路径**。
 * 做法是提交远端任务 → 轮询进度 → 把产物下载到 `spec.output` → 返回 `spec.output`，
 * 于是 `indexttsDispatcher.execute()/persistResult()` 一字不用改：产物照样经
 * `fs.copyFileSync` 落进 `uploads/YYYY/MM/DD/`，`finally` 里的临时文件清理也照旧。
 *
 * 不用 `utils/Axios.ts`：那边有 5s 全局超时，且会把响应体 `JSON.stringify` 进日志 ——
 * 对二进制产物下载是灾难。这里用 Node 22 原生 fetch/FormData/File。
 */
export class IndexttsHttpClient implements IndexttsEngine {
    readonly kind = 'remote' as const;

    private job: Promise<string> | null = null;
    private lastProgress: IndexttsProgress | null = null;
    /** 连续失败计数，达到 workerMaxCrashes 后 isUnhealthy() 为真 */
    private failures = 0;

    /** 远端健康探测缓存（避免每个调度 tick 都打一次网络） */
    private reachable = true;
    private modelReady = false;
    private probedAt = 0;
    private probeError = '';
    private cachedInfo: IndexttsEngineInfo | null = null;

    constructor(private readonly cfg: typeof indexttsConfig = indexttsConfig) {}

    // ---- 状态查询 ----

    isReady(): boolean {
        return this.modelReady;
    }

    isBusy(): boolean {
        return this.job !== null;
    }

    isUnhealthy(): boolean {
        return this.failures >= this.cfg.workerMaxCrashes;
    }

    /** 远端进程不在本进程树下 */
    getPid(): number | null {
        return null;
    }

    getLastProgress(): IndexttsProgress | null {
        return this.lastProgress;
    }

    /**
     * 远端服务重启期间返回 false，让任务留在 pending 而不是被烧成 failed。
     *
     * 判据是「服务可达」而非「模型就绪」：模型加载中同样应该放行 —— 任务入队后会
     * 显示 indextts_load 阶段，正是期望的 UX。若以模型就绪为条件，且容器 EAGER_LOAD=false，
     * 就会出现「没人领任务 → 没人触达 warmup → 永远不就绪」的死锁。
     */
    async canAcceptWork(): Promise<boolean> {
        if (this.isUnhealthy()) return false;
        await this.probeIfStale();
        return this.reachable;
    }

    async getEngineInfo(): Promise<IndexttsEngineInfo> {
        try {
            const res = await this.request('/api/v1/status', {}, 5_000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as Record<string, any>;
            const gpu = data.gpu;
            this.modelReady = data.ready === true;
            this.reachable = true;
            this.probeError = '';
            this.probedAt = Date.now();
            this.cachedInfo = {
                kind: 'remote',
                baseUrl: this.cfg.baseUrl,
                modelReady: this.modelReady,
                loading: data.loading === true,
                loadCount: typeof data.load_count === 'number' ? data.load_count : undefined,
                remoteQueueDepth: typeof data.queue?.depth === 'number' ? data.queue.depth : undefined,
                gpu: gpu
                    ? {
                          name: String(gpu.name ?? ''),
                          memUsedMiB: Number(gpu.mem_used_mib ?? 0),
                          memTotalMiB: Number(gpu.mem_total_mib ?? 0),
                      }
                    : null,
            };
            return this.cachedInfo;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.reachable = false;
            this.modelReady = false;
            this.probeError = message;
            this.probedAt = Date.now();
            return { kind: 'remote', baseUrl: this.cfg.baseUrl, modelReady: false, error: message };
        }
    }

    // ---- 就绪 ----

    async ensureReady(): Promise<void> {
        await this.probeIfStale(true);
        if (this.modelReady) return;

        // 幂等触发加载：容器可能是 EAGER_LOAD=false，或上次加载失败
        await this.request('/api/v1/admin/warmup', { method: 'POST' }, 10_000).catch(() => null);

        const deadline = Date.now() + this.cfg.readyTimeoutMs;
        while (Date.now() < deadline) {
            await sleep(2_000);
            await this.probeIfStale(true);
            if (this.modelReady) return;
        }
        throw new Error(
            `IndexTTS 推理服务未就绪（等待 ${Math.round(this.cfg.readyTimeoutMs / 1000)}s）：` +
                `${this.cfg.baseUrl}${this.probeError ? `（${this.probeError}）` : ''}`,
        );
    }

    /** 以 TTL 缓存健康探测，避免调度 tick（默认 1.5s）每次都打网络 */
    private async probeIfStale(force = false): Promise<void> {
        const ttl = Math.min(this.cfg.pollIntervalMs * 4, 10_000);
        if (!force && Date.now() - this.probedAt < ttl) return;
        this.probedAt = Date.now();
        try {
            // /readyz 无鉴权，模型未就绪时返回 503
            const res = await this.request('/readyz', {}, 5_000);
            this.reachable = true;
            this.modelReady = res.ok;
            this.probeError = '';
        } catch (err) {
            this.reachable = false;
            this.modelReady = false;
            this.probeError = err instanceof Error ? err.message : String(err);
        }
    }

    // ---- 合成 ----

    async run(spec: IndexttsJobSpec, onProgress?: IndexttsProgressHandler): Promise<string> {
        if (this.job) {
            throw new Error('IndexTTS 推理服务正忙，无法并发提交任务');
        }
        const running = this.execute(spec, onProgress);
        this.job = running;
        try {
            return await running;
        } finally {
            this.job = null;
        }
    }

    /** remote 下没有「一次性子进程」的概念，保持契约等价即可 */
    async runOneShot(spec: IndexttsJobSpec, onProgress?: IndexttsProgressHandler): Promise<string> {
        return this.run(spec, onProgress);
    }

    /** 远端服务为多环境共用，Node **绝不能**关停它 */
    async shutdown(): Promise<void> {
        // 刻意留空：dispatcher 在让出 leader 时会调用本方法，那里对本地 worker 是
        // 「关掉占显存的模型」，对远端服务则必须什么都不做。
    }

    private async execute(spec: IndexttsJobSpec, onProgress?: IndexttsProgressHandler): Promise<string> {
        const jobId = await this.submit(spec);
        try {
            const final = await this.pollUntilDone(jobId, onProgress);
            if (final.state !== 'succeeded') {
                this.failures += 1;
                throw new Error(final.error || `IndexTTS 合成失败（state=${final.state}）`);
            }
            await this.download(jobId, spec.output);
            this.failures = 0;
            return spec.output;
        } catch (err) {
            // 请求本身的问题（clientFault）不把引擎判为熔断，否则一条文案超长的任务
            // 就会让后续所有任务都进不来
            if (!(err instanceof IndexttsHttpError && err.clientFault)) {
                this.failures += 1;
            }
            throw err;
        }
    }

    private async submit(spec: IndexttsJobSpec): Promise<string> {
        const text = spec.textFile
            ? await fsp.readFile(spec.textFile, 'utf-8')
            : (spec.text ?? '');
        const reference = await fsp.readFile(spec.reference);

        // 队列满（429）属于暂时性背压，退避重试而不是让任务失败
        const maxAttempts = 5;
        for (let attempt = 1; ; attempt += 1) {
            const form = new FormData();
            form.set('text', text);
            form.set('speed', spec.speed);
            if (spec.clientJobId) form.set('client_job_id', spec.clientJobId);
            form.set('reference', new File([reference], path.basename(spec.reference), { type: 'audio/wav' }));

            let res: Response;
            try {
                res = await this.request('/api/v1/jobs', { method: 'POST', body: form }, 60_000);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new Error(`提交合成任务失败（${this.cfg.baseUrl}）：${message}`);
            }

            if (res.status === 429) {
                if (attempt >= maxAttempts) {
                    throw new Error(`IndexTTS 服务队列持续繁忙，已重试 ${maxAttempts} 次`);
                }
                // 退避节奏与轮询节奏同源：二者都是「多久问一次服务」的同一档语义
                await sleep(Math.min(Math.max(this.cfg.pollIntervalMs, 200) * attempt, 10_000));
                continue;
            }
            if (!res.ok) {
                // 4xx 是请求本身的问题（文案超长 / 参考音非法），失败的只是这一条任务
                throw new IndexttsHttpError(
                    await readError(res, '提交合成任务失败'),
                    res.status,
                    res.status < 500,
                );
            }

            const body = (await res.json()) as { job_id?: string };
            if (!body.job_id) throw new IndexttsHttpError('推理服务未返回 job_id', 502);
            logger.info(
                `[IndexttsHttpClient] 已提交任务 job=${body.job_id} clientJob=${spec.clientJobId ?? '-'} ref=${spec.reference}`,
            );
            return body.job_id;
        }
    }

    private async pollUntilDone(
        jobId: string,
        onProgress?: IndexttsProgressHandler,
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
                    throw new Error(`轮询推理服务连续失败（${consecutiveErrors} 次）：${message}`);
                }
                await sleep(delay);
                continue;
            }

            if (res.status === 404) {
                // 容器重启后丢失了 job 注册表 —— 明确报错，别让调用方干等到超时
                throw new IndexttsHttpError('推理服务不认识该任务（服务可能已重启），任务中断', 404);
            }
            if (!res.ok) {
                consecutiveErrors += 1;
                if (consecutiveErrors >= 5) {
                    throw new IndexttsHttpError(await readError(res, '查询任务状态失败'), res.status);
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
                this.lastProgress = {
                    pct: snap.progress,
                    stage: snap.stage,
                    ...(snap.segCur != null ? { segCur: snap.segCur } : {}),
                    ...(snap.segTotal != null ? { segTotal: snap.segTotal } : {}),
                    ...(snap.audioSec != null ? { audioSec: snap.audioSec } : {}),
                };
                onProgress?.(this.lastProgress);
            }

            if (TERMINAL_STATES.has(snap.state)) return snap;
            await sleep(delay);
        }

        throw new Error(`IndexTTS 合成超时（${Math.round(this.cfg.jobTimeoutMs / 1000)}s），job=${jobId}`);
    }

    /**
     * 把远端产物下载到 `spec.output`。
     *
     * 先写 `.part` 再 rename：调度器只应看到完整文件（`persistResult` 会立刻读取）。
     * 用 arrayBuffer 而非流式管道 —— 产物是分钟级语音，至多几十 MB，一次性读入内存
     * 换来的类型安全与简洁更划算。
     */
    private async download(jobId: string, destAbs: string): Promise<void> {
        const res = await this.request(`/api/v1/jobs/${jobId}/result`, {}, 120_000);
        if (!res.ok) {
            throw new IndexttsHttpError(await readError(res, '下载合成产物失败'), res.status);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.byteLength < 1_000) {
            throw new IndexttsHttpError(`合成产物为空或过小（${buffer.byteLength} 字节）`, 502);
        }

        await fsp.mkdir(path.dirname(destAbs), { recursive: true });
        const tmp = `${destAbs}.part`;
        try {
            await fsp.writeFile(tmp, buffer);
            await fsp.rename(tmp, destAbs);
        } catch (err) {
            await fsp.rm(tmp, { force: true }).catch(() => {});
            throw err;
        }
    }

    // ---- HTTP 基础设施 ----

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

/** 供测试与排障使用 */
export { IndexttsHttpError };
export type { RemoteJobSnapshot };
