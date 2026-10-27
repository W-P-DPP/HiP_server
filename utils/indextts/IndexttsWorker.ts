import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import readline, { type Interface } from 'node:readline';
import { Logger } from '../Logger.ts';
import { INDEXTTS_PROGRESS_MARKER } from '../constant/indextts.ts';
import indexttsConfig, {
  resolveIndexttsPython,
  indexttsWorkerScript,
  indexttsOneshotScript,
  writeIndexttsJsonConfig,
  indexttsWorkerKey,
} from './indextts.config.ts';
import type { IndexttsEngine, IndexttsEngineInfo } from './IndexttsEngine.ts';

const logger = Logger.getInstance();

/** 发给 Python worker 的任务（一行 JSON） */
export interface IndexttsJobSpec {
  text?: string;
  textFile?: string;
  /** 输出 wav 的绝对路径 */
  output: string;
  /** 参考音 wav 的绝对路径 */
  reference: string;
  /** 速度档位：fast / balanced / quality */
  speed: string;
  /**
   * 调用方任务 id（Node 侧为 Mongo taskId）。
   * local 模式下不参与 stdio 协议，仅用于日志关联；remote 模式下作为幂等键上行。
   */
  clientJobId?: string;
}

/** 进度回调入参；stage 为 ASCII key，中文映射在 utils/constant/indextts.ts */
export interface IndexttsProgress {
  pct: number;
  stage: string;
  segCur?: number;
  segTotal?: number;
  audioSec?: number;
}

export type IndexttsProgressHandler = (progress: IndexttsProgress) => void;

/** 解析一行 @@PROGRESS@@ 标记；非标记行返回 null */
function parseMarker(line: string): IndexttsProgress | null {
  if (!line.startsWith(INDEXTTS_PROGRESS_MARKER)) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 3) return null;
  const pct = Number(parts[1]);
  const stage = parts[2];
  if (!Number.isFinite(pct) || !stage) return null;

  const progress: IndexttsProgress = { pct, stage };
  for (const part of parts.slice(3)) {
    const seg = /^seg=(\d+)\/(\d+)$/.exec(part);
    if (seg) {
      progress.segCur = Number(seg[1]);
      progress.segTotal = Number(seg[2]);
      continue;
    }
    const audio = /^audio=([\d.]+)$/.exec(part);
    if (audio) progress.audioSec = Number(audio[1]);
  }
  return progress;
}

/** 进程内单次在途任务 */
interface InFlightJob {
  resolve: (rawAudio: string) => void;
  reject: (err: Error) => void;
  onProgress?: IndexttsProgressHandler;
  timer: NodeJS.Timeout;
}

/**
 * IndexTTS2 常驻子进程管理器。
 *
 * 模型只在首次 spawn 时加载一次并常驻显存，后续任务以「一行 JSON 进、若干进度行 + 一行
 * JSON 出」的方式复用（协议见 services/indextts/indextts_worker.py）。
 *
 * 与上游 JY_IPAgent 的一处刻意偏离：那边把 stderr 合并进 stdout 再逐行 json.loads，
 * 杂散 traceback 会污染 JSON 通道；这里 stdout 单独走 readline 解析，stderr 独立
 * **持续 drain** 到日志（不 drain 会写满管道把子进程卡死）。
 *
 * 单例：按 installDir|modelDir 记忆化，配置变化时重建进程（对应上游 _worker_cfg_key）。
 */
class IndexttsWorker implements IndexttsEngine {
  readonly kind = 'local' as const;

  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private ready = false;
  /** 正在进行的 spawn+握手，避免并发重复拉起 */
  private starting: Promise<void> | null = null;
  private job: InFlightJob | null = null;
  /** 连续崩溃计数：超过上限后上层回退一次性子进程 */
  private crashes = 0;
  /** 当前进程对应的配置键 */
  private currentKey = '';

  /** 最近一次合成进度，供 /engine/status 观测 */
  private lastProgress: IndexttsProgress | null = null;

  constructor(private readonly cfg: typeof indexttsConfig = indexttsConfig) {}

  /** worker 是否已就绪（模型已加载、可接任务） */
  isReady(): boolean {
    return this.ready && this.proc !== null && this.proc.exitCode === null;
  }

  /** 当前 worker 进程 pid；未拉起时为 null（/engine/status 用） */
  getPid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** 是否因反复崩溃被判定为不可用 */
  isUnhealthy(): boolean {
    return this.crashes >= this.cfg.workerMaxCrashes;
  }

  /**
   * 本地模式只要没被熔断就允许领取任务。
   *
   * **刻意不以 `isReady()` 为条件**：本地 worker 是懒加载的（首个任务才触发加载，
   * 冷启动 1–3 分钟）。若以模型就绪为领取条件，就永远不会有人领取第一个任务，
   * 加载也就永远不会被触发 —— 死锁。远端模式没有这个问题（容器自己 EAGER_LOAD）。
   */
  async canAcceptWork(): Promise<boolean> {
    return !this.isUnhealthy();
  }

  getEngineInfo(): Promise<IndexttsEngineInfo> {
    return Promise.resolve({
      kind: 'local' as const,
      modelReady: this.isReady(),
      loading: this.starting !== null,
      gpu: null,
    });
  }

  getLastProgress(): IndexttsProgress | null {
    return this.lastProgress;
  }

  /** 是否已有任务在跑（GPU 并发恒为 1） */
  isBusy(): boolean {
    return this.job !== null;
  }

  /**
   * 拉起 worker 并等待模型加载完成。
   * 首次加载 1–3 分钟，超时用 INDEXTTS_READY_TIMEOUT_MS（默认 600s）。
   */
  async ensureReady(): Promise<void> {
    if (this.isReady()) return;
    if (this.starting) return this.starting;

    this.starting = this.spawnAndHandshake().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnAndHandshake(): Promise<void> {
    const cfg = this.cfg;
    const python = resolveIndexttsPython(cfg);
    const script = indexttsWorkerScript(cfg);

    if (!fs.existsSync(script)) {
      return Promise.reject(new Error(`IndexTTS worker 脚本不存在: ${script}`));
    }
    // 配置写盘失败（如 runtimeDir 无写权限）也应在拉起进程前暴露
    let configPath: string;
    try {
      configPath = writeIndexttsJsonConfig(cfg);
    } catch (err) {
      return Promise.reject(
        new Error(`IndexTTS 配置写入失败（${cfg.runtimeDir}）：${err instanceof Error ? err.message : err}`),
      );
    }

    logger.info(`[IndexttsWorker] 启动 worker：${python} ${script}（install=${cfg.installDir}）`);

    const proc = spawn(python, ['-u', script, '--config', configPath, '--stdio'], {
      cwd: fs.existsSync(cfg.installDir) ? cfg.installDir : process.cwd(),
      env: {
        ...process.env,
        // IndexTTS 要求安装根在 sys.path 上（官方文档的 PYTHONPATH=.）
        PYTHONPATH: [cfg.installDir, cfg.engineDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc = proc;
    this.currentKey = indexttsWorkerKey(cfg);
    this.ready = false;

    // stderr 必须持续消费：不读会写满管道导致子进程阻塞
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trimEnd();
      if (text) logger.info(`[IndexttsWorker:${proc.pid}] ${text}`);
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.killProc();
        reject(
          new Error(
            `IndexTTS worker 加载超时（${Math.round(cfg.readyTimeoutMs / 1000)}s）。` +
              '首次加载模型通常需 1–3 分钟，若持续超时请检查 GPU 显存与权重完整性。',
          ),
        );
      }, cfg.readyTimeoutMs);
      timer.unref();

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      this.rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });

      this.rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        const progress = parseMarker(trimmed);
        if (progress) {
          this.routeProgress(progress);
          return;
        }
        if (!trimmed.startsWith('{')) return;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          logger.warn(`[IndexttsWorker] 无法解析 worker 输出行：${trimmed.slice(0, 200)}`);
          return;
        }

        if ('ready' in data) {
          if (data.ready === true) {
            this.ready = true;
            // 刻意不在这里清空 crashes：能加载模型不等于能跑推理。若加载成功但每个任务都
            // OOM，在此清零会让熔断器永远无法触发、每个请求都白等 1–3 分钟重新加载。
            // 崩溃计数只在「任务真正合成成功」后清零（见 routeJobResult）。
            logger.info(`[IndexttsWorker] 模型已就绪（pid=${proc.pid}）`);
            finish();
          } else {
            finish(new Error(`IndexTTS worker 未就绪：${String(data.error ?? 'unknown')}`));
          }
          return;
        }

        this.routeJobResult(data);
      });

      proc.on('error', (err: Error) => {
        finish(new Error(`IndexTTS worker 启动失败：${err.message}`));
      });

      proc.on('exit', (code, signal) => {
        const wasReady = this.ready;
        this.handleExit(code, signal);
        finish(new Error(`IndexTTS worker 启动失败（进程已退出，code=${code ?? signal}）`));
        if (wasReady) {
          logger.warn(`[IndexttsWorker] worker 退出（code=${code ?? signal}）`);
        }
      });
    });
  }

  /** 进度行：在途任务回吞，否则只留作观测值 */
  private routeProgress(progress: IndexttsProgress): void {
    this.lastProgress = progress;
    this.job?.onProgress?.(progress);
  }

  /** 结果行：只有任务在途时才消费，否则视为噪声（例如 pong/shutdown 回执） */
  private routeJobResult(data: Record<string, unknown>): void {
    const job = this.job;
    if (!job) return;
    if (!('ok' in data)) return;

    clearTimeout(job.timer);
    this.job = null;

    if (data.ok === true) {
      // 真正跑通一次推理才清零崩溃计数（加载成功不算，见握手处的说明）
      this.crashes = 0;
      job.resolve(String(data.raw_audio ?? ''));
      return;
    }
    const err = String(data.error ?? '合成失败');
    const trace = data.trace ? `\n${String(data.trace)}` : '';
    job.reject(new Error(`${err}${trace}`));
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasReady = this.ready;
    this.ready = false;
    this.rl?.close();
    this.rl = null;
    this.proc = null;

    const job = this.job;
    if (job) {
      clearTimeout(job.timer);
      this.job = null;
      job.reject(new Error(`IndexTTS worker 意外退出（code=${code ?? signal}），任务中断`));
    }
    // 只有「曾经就绪过」的退出才算崩溃：启动期失败由握手 Promise 报错，不该计入
    if (wasReady) this.crashes += 1;
  }

  /**
   * 提交一次合成任务（单飞：GPU 并发恒为 1，调用方必须串行）。
   * @returns 生成的 wav 绝对路径
   */
  async run(spec: IndexttsJobSpec, onProgress?: IndexttsProgressHandler): Promise<string> {
    if (this.job) {
      throw new Error('IndexTTS worker 正忙，无法并发提交任务');
    }
    await this.ensureReady();
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || !proc.stdin) {
      throw new Error('IndexTTS worker 不可用');
    }

    const payload: Record<string, unknown> = {
      output: spec.output,
      reference: spec.reference,
      speed: spec.speed,
    };
    if (spec.textFile) payload.text_file = spec.textFile;
    else payload.text = spec.text ?? '';

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.job = null;
        // stdio 协议下无法安全放弃在途任务 —— 只能杀掉进程，让上层重启
        this.killProc();
        reject(new Error(`IndexTTS 合成超时（${Math.round(this.cfg.jobTimeoutMs / 1000)}s），已终止 worker`));
      }, this.cfg.jobTimeoutMs);
      timer.unref();

      this.job = { resolve, reject, ...(onProgress ? { onProgress } : {}), timer };

      try {
        proc.stdin!.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.job = null;
        reject(new Error(`IndexTTS 任务写入失败：${err instanceof Error ? err.message : err}`));
      }
    });
  }

  /**
   * 一次性子进程兜底（worker 关闭或反复崩溃时）。
   * 每次调用都要重新加载模型（1–3 分钟），属正确性兜底而非性能方案。
   */
  async runOneShot(spec: IndexttsJobSpec, onProgress?: IndexttsProgressHandler): Promise<string> {
    const cfg = this.cfg;
    const python = resolveIndexttsPython(cfg);
    const script = indexttsOneshotScript(cfg);
    if (!fs.existsSync(script)) throw new Error(`IndexTTS 一次性脚本不存在: ${script}`);

    const configPath = writeIndexttsJsonConfig(cfg);
    const args = ['-u', script, '--config', configPath, '--output', spec.output, '--reference', spec.reference, '--speed', spec.speed];
    if (spec.textFile) args.push('--text-file', spec.textFile);
    else args.push('--text', spec.text ?? '');

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(python, args, {
        cwd: fs.existsSync(cfg.installDir) ? cfg.installDir : process.cwd(),
        env: {
          ...process.env,
          PYTHONPATH: [cfg.installDir, cfg.engineDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`IndexTTS 一次性合成超时（${Math.round(cfg.jobTimeoutMs / 1000)}s）`));
      }, cfg.jobTimeoutMs);
      timer.unref();

      // spawn 失败（如解释器不存在 ENOENT）会以 'error' 事件抛出；没有监听器时 Node 会把它
      // 变成未捕获异常直接杀掉进程 —— 必须显式接住
      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`IndexTTS 一次性合成无法启动（${python}）：${err.message}`));
      });

      let stderrTail = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stderrTail = `${stderrTail}${text}`.slice(-2000);
        logger.info(`[IndexttsOneshot:${proc.pid}] ${text.trimEnd()}`);
      });

      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const progress = parseMarker(trimmed);
        if (progress) {
          this.lastProgress = progress;
          onProgress?.(progress);
          return;
        }
        if (!trimmed.startsWith('{')) return;
        try {
          const data = JSON.parse(trimmed) as Record<string, unknown>;
          if (data.ok === true) {
            clearTimeout(timer);
            resolve(String(data.raw_audio ?? ''));
          } else if (data.ok === false) {
            clearTimeout(timer);
            reject(new Error(`${String(data.error ?? '合成失败')}${data.trace ? `\n${String(data.trace)}` : ''}`));
          }
        } catch {
          // 非 JSON 行忽略
        }
      });

      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`IndexTTS 一次性合成失败（code=${code}）${stderrTail ? `：${stderrTail.trim()}` : ''}`));
      });
    });
  }

  /** 优雅关闭：发 shutdown 指令，等待退出，超时 SIGKILL */
  async shutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    logger.info(`[IndexttsWorker] 关闭 worker（pid=${proc.pid}）`);

    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null) {
        resolve();
        return;
      }
      proc.once('exit', () => resolve());
    });

    try {
      proc.stdin?.write('shutdown\n');
    } catch {
      // 管道可能已断，直接进入等待/强杀
    }

    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 5000);
      timer.unref();
    });

    await Promise.race([exited, timeout]);
    this.ready = false;
    this.proc = null;
  }

  /** 立即终止（超时/异常路径使用） */
  private killProc(): void {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.kill('SIGKILL');
    } catch {
      // 进程可能已退出
    }
  }
}

/** 记忆化单例：配置键变化时重建 */
let instance: IndexttsWorker | null = null;
let instanceKey = '';

export function getIndexttsWorker(cfg: typeof indexttsConfig = indexttsConfig): IndexttsWorker {
  const key = indexttsWorkerKey(cfg);
  if (!instance || instanceKey !== key) {
    if (instance) void instance.shutdown();
    instance = new IndexttsWorker(cfg);
    instanceKey = key;
  }
  return instance;
}

export { IndexttsWorker };
