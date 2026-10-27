/** IndexTTS2 音色克隆相关常量 */
import { envInt, envStr, resolveFromCwd, stripTrailingSlash } from './envParse.ts';
import type { IndexttsMode } from '../indextts/IndexttsEngine.ts';

/**
 * 子进程只会输出 ASCII 阶段 key（Python 侧 `services/indextts/progress.py` 的约定，
 * 为避免 Windows 编码问题），中文标签只在这层映射。
 * 取自 JY_IPAgent 的 tts/progress.py，只保留本场景会出现的 4 个 key。
 */
export const INDEXTTS_STAGE_LABELS: Record<string, string> = {
  pending: '排队中',
  config: '读取配置',
  indextts_load: '加载 IndexTTS 模型（首次较慢）',
  indextts_ready: '模型已常驻',
  indextts_synth: 'IndexTTS 合成中',
  indextts_done: '合成完成',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 阶段 key → 中文描述（未知 key 原样返回，便于发现协议新增值） */
export function indexttsStageLabel(stage: string): string {
  return INDEXTTS_STAGE_LABELS[stage] ?? stage;
}

/** 未传 text 时用于试听的默认文案 */
export const PREVIEW_DEFAULT_TEXT = '你好，这是音色克隆试听效果。';

/** 合成速度档位（对齐 Python 侧 SPEED_PRESETS） */
export const SYNTHESIS_SPEED_MODES = ['fast', 'balanced', 'quality'] as const;

export type SynthesisSpeedMode = (typeof SYNTHESIS_SPEED_MODES)[number];

/** 默认速度档位 */
export const DEFAULT_SPEED_MODE: SynthesisSpeedMode = 'balanced';

/** worker stdout 上的进度标记前缀（与 Python 侧 MARKER 必须一致） */
export const INDEXTTS_PROGRESS_MARKER = '@@PROGRESS@@';

/** 解析运行模式：remote=调用独立 GPU 服务；local=本机 spawn；off=禁用 */
function resolveIndexttsMode(): IndexttsMode {
  const raw = envStr('INDEXTTS_MODE').trim().toLowerCase();
  if (raw === 'remote' || raw === 'local' || raw === 'off') return raw;
  // 未设置（或写了不认识的値）时按「配了远端地址就是 remote」推断，保持向后兼容
  return envStr('INDEXTTS_BASE_URL').trim() ? 'remote' : 'local';
}

/**
 * IndexTTS2 音色克隆环境变量常量。
 *
 * `INDEXTTS_ENABLED` 是总开关（mode=off 同样视为关闭）；`INDEXTTS_MAX_TEXT_CHARS` 属
 * 「长文本合成」口径，须与 GPU 服务侧一致。
 */
export class IndexttsConstants {
  /** 运行模式：remote / local / off（未配置时按 BASE_URL 推断） */
  public static readonly MODE: IndexttsMode = resolveIndexttsMode();

  /** 远端 GPU 服务地址（去尾斜杠），仅 remote 模式使用 */
  public static readonly BASE_URL: string = stripTrailingSlash(envStr('INDEXTTS_BASE_URL', 'http://127.0.0.1:39010'));

  /** 远端服务鉴权 token，需与容器侧一致 */
  public static readonly API_TOKEN: string = envStr('INDEXTTS_API_TOKEN').trim();

  /** 总开关：mode=off ⇒ 不启动 dispatcher，合成接口 503 */
  public static readonly ENABLED: boolean = IndexttsConstants.MODE !== 'off';

  /** 是否使用常驻 worker（仅 local 有效） */
  public static readonly WORKER_ENABLED: boolean = true;

  /** 启动即预热模型（仅 local 有效）；仅控制预热，不控制调度器 */
  public static readonly AUTOSTART: boolean = false;

  /** 是否允许 worker 自动下载缺失权重 */
  public static readonly ALLOW_DOWNLOAD: boolean = false;

  /** IndexTTS2 检出目录（含 indextts/ 包与 checkpoints/） */
  public static readonly INSTALL_DIR: string = resolveFromCwd('services/indextts/engine');

  /** 权重目录，相对 INSTALL_DIR */
  public static readonly MODEL_DIR: string = 'checkpoints';

  /** Python 解释器；留空则自动探测 */
  public static readonly PYTHON: string = '';

  /** 桥接脚本目录 */
  public static readonly ENGINE_DIR: string = resolveFromCwd(envStr('INDEXTTS_ENGINE_DIR', 'services/indextts'));

  /** 运行期目录（JSON 配置 + 合成产物） */
  public static readonly RUNTIME_DIR: string = resolveFromCwd(envStr('INDEXTTS_RUNTIME_DIR', '.runtime/indextts'));

  /** 冷启动超时 ms（首次加载模型 1–3 分钟，勿调小） */
  public static readonly READY_TIMEOUT_MS: number = envInt('INDEXTTS_READY_TIMEOUT_MS', 600_000);

  /** 单个合成任务超时 ms */
  public static readonly JOB_TIMEOUT_MS: number = 3_600_000;

  /** 连续崩溃次数上限，超过则回退一次性子进程 */
  public static readonly WORKER_MAX_CRASHES: number = envInt('INDEXTTS_WORKER_MAX_CRASHES', 3);

  /** dispatcher 轮询间隔 ms */
  public static readonly POLL_INTERVAL_MS: number = envInt('INDEXTTS_POLL_INTERVAL_MS', 1500);

  /** leader 租约 TTL ms（全机只允许一个热模型） */
  public static readonly LEASE_TTL_MS: number = envInt('INDEXTTS_LEASE_TTL_MS', 60_000);

  /** 陈旧任务判定阈值 ms，必须大于「冷启动 + 单任务」 */
  public static readonly TASK_STALE_MS: number = 5_400_000;

  /** 进度写库最小间隔 ms */
  public static readonly PROGRESS_MIN_INTERVAL_MS: number = envInt('INDEXTTS_PROGRESS_MIN_INTERVAL_MS', 1000);

  /** 单次请求文本长度上限（长文本合成） */
  public static readonly MAX_TEXT_CHARS: number = 5000;

  /** FP16 推理；显存吃紧时 fp32 装不下 */
  public static readonly USE_FP16: boolean = true;

  /** 采样参数 */
  public static readonly TEMPERATURE: number = Number(envStr('INDEXTTS_TEMPERATURE', '0.8'));
  public static readonly TOP_P: number = Number(envStr('INDEXTTS_TOP_P', '0.8'));
  public static readonly TOP_K: number = envInt('INDEXTTS_TOP_K', 30);
  public static readonly INTERVAL_SILENCE: number = envInt('INDEXTTS_INTERVAL_SILENCE', 200);
  public static readonly MAX_TEXT_TOKENS_PER_SEGMENT: number = envInt('INDEXTTS_MAX_TEXT_TOKENS_PER_SEGMENT', 120);
  public static readonly CLONE_TEMPERATURE: number = Number(envStr('INDEXTTS_CLONE_TEMPERATURE', '0.75'));
}
