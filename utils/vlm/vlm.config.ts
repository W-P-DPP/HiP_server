// utils/vlm/vlm.config.ts
import { VLM_DEFAULT_PROMPT, VLM_DEFAULT_TEXT_PROMPT } from '../constant/vlm.ts';

/** 从 env 读整数，非法值/缺省回退默认值（?x=abc 类输入不应让配置变成 NaN） */
function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 从 env 读布尔，只有显式 'true'/'1' 才算真 */
function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * 图片理解（Qwen3-VL）配置。
 *
 * 一个文件里放两组参数（与 `utils/aiDetect/aiDetect.config.ts` 同一写法）：
 * - **客户端**：怎么访问独立的 GPU 容器（`VLM_MODE` / `VLM_BASE_URL` / 各类超时）
 * - **模块**：本服务自己的任务队列与调度器（`VLM_ENABLED` / 体积上限 / scheduler）
 *
 * `enabled` 与 `configured` 是**两个独立开关**，不要混用：
 * - `enabled`  模块总开关。关闭时提交接口 503、调度器不启动。
 * - `configured` 客户端可用（mode=remote 且配了 baseUrl）。未配置时提交接口同样 503 ——
 *   因为收下的任务注定会在执行时失败，不如当场告诉用户。
 */
const mode = (process.env.VLM_MODE || 'off').trim().toLowerCase();
const baseUrl = (process.env.VLM_BASE_URL || '').trim().replace(/\/+$/, '');

const vlmConfig = {
  /** 模块总开关：false 时提交接口 503，调度器不启动 */
  enabled: envBool(process.env.VLM_ENABLED, true),

  /** 运行模式：remote=调用独立部署的 GPU 容器；off=禁用（默认） */
  mode,
  /** 容器地址（去掉尾部斜杠）。宿主回环 39030；容器内走共享网络 http://vlm-server:8000 */
  baseUrl,
  /** 鉴权 token，需与容器侧 VLM_API_TOKEN 一致 */
  apiToken: process.env.VLM_API_TOKEN || '',
  /** 客户端是否可用：mode=remote 且配了 baseUrl 才算 */
  configured: mode === 'remote' && baseUrl !== '',

  /** 任务状态轮询间隔（ms），也是 429 退避的基数 */
  pollIntervalMs: envInt(process.env.VLM_POLL_INTERVAL_MS, 1_500),
  /** 就绪等待 / 探活超时（ms） */
  readyTimeoutMs: envInt(process.env.VLM_READY_TIMEOUT_MS, 600_000),
  /** 单个理解任务超时（ms）。含容器冷启动加载模型的数十秒 */
  jobTimeoutMs: envInt(process.env.VLM_JOB_TIMEOUT_MS, 600_000),

  /**
   * 源图片上限（字节）。同时是上传路由 multer 的传输上限与业务上限。
   *
   * 按路由给上限、而不是抬升全局 `FILE_MAX_SIZE`（50MB）—— 后者是给所有上传接口
   * （skill 包、公众号素材、音色样本…）共用的，为图片理解放宽它会顺带放宽其它接口。
   * default 20MB：图片场景远小于视频，且远超模型实际会看的像素量。
   */
  maxImageBytes: envInt(process.env.VLM_MAX_IMAGE_BYTES, 20 * 1024 * 1024),

  /** mode=json 的默认指令（VLM_DEFAULT_PROMPT 可覆盖，便于不开代码调措辞） */
  promptJson: (process.env.VLM_DEFAULT_PROMPT || '').trim() || VLM_DEFAULT_PROMPT,
  /** mode=text 的默认指令 */
  promptText: (process.env.VLM_DEFAULT_TEXT_PROMPT || '').trim() || VLM_DEFAULT_TEXT_PROMPT,

  /** 后台任务调度器（leader 租约 + FIFO 领取，见 src/vlm/vlmDispatcher.ts） */
  scheduler: {
    /** 调度 tick 间隔（ms） */
    pollIntervalMs: envInt(process.env.VLM_DISPATCH_POLL_INTERVAL_MS, 3_000),
    /**
     * 在途任务数上限。容器侧 GPU 并发恒为 1，这里放大并发只会把请求堆在它的队列里，
     * 所以默认与容器保持一致。
     */
    concurrency: Math.max(1, envInt(process.env.VLM_CONCURRENCY, 1)),
    /** 进度写库最小间隔（ms） */
    progressMinIntervalMs: envInt(process.env.VLM_PROGRESS_MIN_INTERVAL_MS, 1_000),
    /** leader 租约 TTL（ms），续期周期为 TTL/2 */
    leaseTtlMs: envInt(process.env.VLM_LEASE_TTL_MS, 60_000),
    /** 调度器 leader 租约键（与其它调度器各自独立） */
    leaderKey: process.env.VLM_LEADER_KEY || 'wxbot:vlm:leader',
    /**
     * 陈旧任务判定阈值（ms）。必须大于「容器冷启动加载模型 + 单图推理」，默认 30 分钟
     * —— 4bit 权重首次加载可达分钟级，阈值给小了会把正在跑的任务误判为孤儿并重排。
     */
    taskStaleMs: envInt(process.env.VLM_TASK_STALE_MS, 30 * 60_000),
  },
} as const;

/** 按输出形态取默认指令 */
export function defaultPromptFor(mode: string): string {
  return mode === 'text' ? vlmConfig.promptText : vlmConfig.promptJson;
}

export default vlmConfig;
