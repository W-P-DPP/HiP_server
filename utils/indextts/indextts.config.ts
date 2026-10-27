import fs from 'node:fs';
import path from 'node:path';

import { IndexttsConstants } from '../constant/indextts.ts';

/**
 * IndexTTS2 音色克隆配置（环境变量读取点在 utils/constant/indextts.ts 的 IndexttsConstants）。
 *
 * 注意 `INDEXTTS_ENABLED` 是总开关：关闭时不启动 dispatcher，`POST /synthesize` 直接 503，
 * 因此在没有 GPU 的机器上也能安全部署本服务（音色库的增删改查只走 ffmpeg，不需要 GPU）。
 *
 * `mode` 决定推理走哪条传输：`remote` 指向独立部署的 GPU 服务容器，本机不需要引擎与
 * Python 环境；`local` 沿用历史上 spawn 本地 Python worker 的方式。
 */
const indexttsConfig = {
  /** 运行模式：remote=独立 GPU 服务；local=本机 spawn；off=禁用 */
  mode: IndexttsConstants.MODE,

  /** 远端 GPU 服务地址（仅 remote 模式使用） */
  baseUrl: IndexttsConstants.BASE_URL,

  /** 远端服务鉴权 token，需与容器侧 INDEXTTS_API_TOKEN 一致 */
  apiToken: IndexttsConstants.API_TOKEN,

  /** 总开关：false（或 mode=off）⇒ 不启动后台 dispatcher，合成接口返回 503 */
  enabled: IndexttsConstants.ENABLED,

  /** 是否使用常驻 worker；false ⇒ 每次合成起一次性子进程（每次重新加载模型 1–3 分钟）。仅 local 有效 */
  workerEnabled: IndexttsConstants.WORKER_ENABLED,

  /**
   * 是否在启动时预热模型（默认关闭：开发机没 GPU 时不应加载 14GB 权重）。
   * **仅控制预热**：调度循环是否运行只看 `enabled`（见 utils/clusterWorker.ts），与它无关。
   */
  autostart: IndexttsConstants.AUTOSTART,

  /** 是否允许 worker 自动下载缺失权重（默认关闭，避免用户请求里触发数 GB 下载） */
  allowDownload: IndexttsConstants.ALLOW_DOWNLOAD,

  /** IndexTTS2 检出目录（含 indextts/ 包与 checkpoints/） */
  installDir: IndexttsConstants.INSTALL_DIR,

  /** 权重目录，相对 installDir */
  modelDir: IndexttsConstants.MODEL_DIR,

  /** Python 解释器；留空则依次探测 <install>/.venv/bin/python、<install>/venv/bin/python */
  pythonPath: IndexttsConstants.PYTHON,

  /** 移植过来的桥接脚本目录（本文件所在仓库的 services/indextts） */
  engineDir: IndexttsConstants.ENGINE_DIR,

  /** 运行期目录：JSON 配置与合成输出暂存 */
  runtimeDir: IndexttsConstants.RUNTIME_DIR,

  /** 冷启动超时；首次加载模型 1–3 分钟，不要调小 */
  readyTimeoutMs: IndexttsConstants.READY_TIMEOUT_MS,

  /** 单个合成任务的 stdio 超时 */
  jobTimeoutMs: IndexttsConstants.JOB_TIMEOUT_MS,

  /** 连续崩溃次数上限，超过则回退一次性子进程并置 healthy=false */
  workerMaxCrashes: IndexttsConstants.WORKER_MAX_CRASHES,

  /** dispatcher 轮询间隔 */
  pollIntervalMs: IndexttsConstants.POLL_INTERVAL_MS,

  /** leader 租约 TTL（到期自动还槽），续期周期为 TTL/2 */
  leaseTtlMs: IndexttsConstants.LEASE_TTL_MS,

  /**
   * 陈旧任务判定阈值。必须大于「冷启动 + 单个合成任务」的总时长，
   * 所以**不能**沿用 V1 视频任务的 30 秒（那会把正在加载模型的合法任务误判为失败）。
   */
  taskStaleMs: IndexttsConstants.TASK_STALE_MS,

  /** 进度写库最小间隔（worker 发 marker 的频率远高于 UI 需要） */
  progressMinIntervalMs: IndexttsConstants.PROGRESS_MIN_INTERVAL_MS,

  /**
   * 单次请求文本长度上限（长文本合成，仅 Node 侧提交校验用；GPU 服务侧有一道同名的独立校验）。
   * 两侧取值必须一致，否则超限文本会提交时放行、调度时才被 GPU 服务拒绝。
   */
  maxTextChars: IndexttsConstants.MAX_TEXT_CHARS,

  /** FP16 推理：20GB 卡在显存吃紧时 fp32 装不下，默认开启 */
  useFp16: IndexttsConstants.USE_FP16,

  /** 采样参数（未在任务上覆盖时生效） */
  temperature: IndexttsConstants.TEMPERATURE,
  topP: IndexttsConstants.TOP_P,
  topK: IndexttsConstants.TOP_K,
  intervalSilence: IndexttsConstants.INTERVAL_SILENCE,
  maxTextTokensPerSegment: IndexttsConstants.MAX_TEXT_TOKENS_PER_SEGMENT,
  /** clone 模式温度上限（对齐上游 clone_temperature） */
  cloneTemperature: IndexttsConstants.CLONE_TEMPERATURE,
} as const;

/** 探测可用的 Python 解释器；显式配置优先，其次 venv 约定路径 */
export function resolveIndexttsPython(cfg: typeof indexttsConfig = indexttsConfig): string {
  if (cfg.pythonPath) return cfg.pythonPath;
  for (const rel of ['.venv/bin/python', 'venv/bin/python', '.venv/Scripts/python.exe']) {
    const candidate = path.join(cfg.installDir, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  // 探测不到就回退 PATH 上的 python3，由 worker 启动报错给出可操作提示
  return 'python3';
}

/** worker 脚本路径 */
export function indexttsWorkerScript(cfg: typeof indexttsConfig = indexttsConfig): string {
  return path.join(cfg.engineDir, 'indextts_worker.py');
}

/** 一次性兜底脚本路径 */
export function indexttsOneshotScript(cfg: typeof indexttsConfig = indexttsConfig): string {
  return path.join(cfg.engineDir, 'run_indextts.py');
}

/** 传给 Python 的 JSON 配置路径 */
export function indexttsJsonConfigPath(cfg: typeof indexttsConfig = indexttsConfig): string {
  return path.join(cfg.runtimeDir, 'indextts.config.json');
}

/**
 * 生成 Python 侧读取的 JSON 配置（写盘）。
 * 由 Node 生成而非共用 config.yaml，是为了让 Python 侧彻底摆脱 PyYAML 依赖。
 */
export function writeIndexttsJsonConfig(cfg: typeof indexttsConfig = indexttsConfig): string {
  fs.mkdirSync(cfg.runtimeDir, { recursive: true });
  const payload = {
    paths: { indextts_dir: cfg.installDir },
    indextts: {
      model_dir: cfg.modelDir,
      use_fp16: cfg.useFp16,
      allow_download: cfg.allowDownload,
      temperature: cfg.temperature,
      top_p: cfg.topP,
      top_k: cfg.topK,
      interval_silence: cfg.intervalSilence,
      max_text_tokens_per_segment: cfg.maxTextTokensPerSegment,
      clone_temperature: cfg.cloneTemperature,
    },
  };
  const target = indexttsJsonConfigPath(cfg);
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf-8');
  return target;
}

/** 该配置下 worker 的记忆化键：installDir/modelDir 变化时需重建进程 */
export function indexttsWorkerKey(cfg: typeof indexttsConfig = indexttsConfig): string {
  return `${cfg.installDir}|${cfg.modelDir}`;
}

export default indexttsConfig;
