import type {
  IndexttsJobSpec,
  IndexttsProgress,
  IndexttsProgressHandler,
} from './IndexttsWorker.ts';

/**
 * IndexTTS 引擎的运行模式。
 *
 * - `remote`：调用独立部署的 GPU 服务（Docker 容器），本机不加载模型
 * - `local` ：沿用历史上的 `spawn` 本地 Python worker（需要本机有引擎与 GPU）
 * - `off`   ：完全不启用，`/synthesize` 直接 503
 *
 * 未显式设置 `INDEXTTS_MODE` 时：配了 `INDEXTTS_BASE_URL` 即为 remote，否则为 local
 * （保持与改造前一致的默认行为）。
 */
export type IndexttsMode = 'remote' | 'local' | 'off';

export interface IndexttsGpuInfo {
  name: string;
  memUsedMiB: number;
  memTotalMiB: number;
}

/** 供 `GET /engine/status` 观测的引擎信息 */
export interface IndexttsEngineInfo {
  kind: 'local' | 'remote';
  /** remote 模式的推理服务地址 */
  baseUrl?: string;
  /** 模型是否已加载、可接任务 */
  modelReady: boolean;
  /** 是否正在加载（冷启动 1–3 分钟） */
  loading?: boolean;
  /** 远端进程内模型加载次数；>1 说明发生了并发加载（例如误设 uvicorn --workers 2） */
  loadCount?: number;
  /** 远端服务自身队列的待跑任务数（不含本进程在途的那个） */
  remoteQueueDepth?: number;
  gpu?: IndexttsGpuInfo | null;
  /** 最近一次探测失败的原因 */
  error?: string;
}

/**
 * 本地 worker 与远端 HTTP 客户端的共同契约。
 *
 * `indexttsDispatcher` 只依赖这个接口，因此「换传输层」不会波及调度、任务状态机、
 * 产物落库与试听回写。两个实现的方法语义必须严格一致 —— 尤其是 `run()`：
 * 无论产物来自本地子进程还是远端服务，都返回**本地** wav 绝对路径。
 */
export interface IndexttsEngine {
  readonly kind: 'local' | 'remote';

  /** 执行一次合成，返回产物 wav 的本地绝对路径 */
  run(spec: IndexttsJobSpec, onProgress?: IndexttsProgressHandler): Promise<string>;
  /** 一次性兜底（本地为重新加载模型；remote 下与 run 等价） */
  runOneShot(spec: IndexttsJobSpec, onProgress?: IndexttsProgressHandler): Promise<string>;

  /** 确认引擎可用（本地为加载模型，remote 为等待远端就绪） */
  ensureReady(): Promise<void>;
  isReady(): boolean;
  isBusy(): boolean;
  /** 连续失败达到阈值后为 true，表示应停止投递 */
  isUnhealthy(): boolean;
  getPid(): number | null;
  getLastProgress(): IndexttsProgress | null;
  /** 优雅关闭。remote 下是空操作 —— 远端服务为多环境共用，Node 无权关停它 */
  shutdown(): Promise<void>;

  /**
   * 是否应领取新任务。
   *
   * 存在的理由：远端服务重启期间返回 false，让 Mongo 里的任务留在 `pending`，
   * 而不是被领取后立刻烧成 `failed`。
   *
   * 注意本地实现**不能**以 `isReady()` 为条件 —— 那会让「首个任务触发加载」的
   * 懒加载永远等不到第一个任务。
   */
  canAcceptWork(): Promise<boolean>;

  getEngineInfo(): Promise<IndexttsEngineInfo>;
}
