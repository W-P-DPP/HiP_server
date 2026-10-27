/** 数字人（HeyGem/Duix）配置（环境变量读取点在 utils/constant/digitalHuman.ts 的 DigitalHumanConstants） */
import { DigitalHumanConstants } from '../constant/digitalHuman.ts';

/**
 * 数字人（HeyGem/Duix）配置。
 *
 * 两条关键约定：
 * ① **共享挂载**：duix 容器不接收 HTTP 上传，而是读取 bind-mount 内的文件。因此
 *    `mountDir`（Node 可见）与 `containerPrefix`（duix 容器内）必须指向同一个宿主机目录，
 *    否则容器读不到音频/参考视频，任务会立刻失败（JY_IPAgent 里最常见的故障）。
 * ② **单调度者**：GPU 与 duix 容器均为全机单实例，用 `leaderKey` 的 Redis 租约收敛调度循环。
 */
const heygemConfig = {
  /** 总开关：false 时提交接口直接 503，形象库（只做 ffmpeg 归一化）仍可用 */
  enabled: DigitalHumanConstants.ENABLED,

  /** duix/HeyGem HTTP 服务地址（dev 本机回环；prod 容器网络内服务名） */
  baseUrl: DigitalHumanConstants.BASE_URL,

  /** Node 可见的共享挂载目录（与 duix 容器挂载的宿主机目录一致） */
  mountDir: DigitalHumanConstants.MOUNT_DIR,

  /** duix 容器内对应 `mountDir` 的前缀 */
  containerPrefix: DigitalHumanConstants.CONTAINER_PREFIX,

  /** 运行期目录：归一化音频与产物暂存（不进 uploads） */
  runtimeDir: DigitalHumanConstants.RUNTIME_DIR,

  /** 提交参数：超分 / 水印 / 并行数（透传 duix，语义见其文档） */
  chaofen: DigitalHumanConstants.CHAOFEN,
  watermarkSwitch: DigitalHumanConstants.WATERMARK,
  pn: DigitalHumanConstants.PN,

  /** 轮询 duix 任务状态的间隔（秒） */
  pollIntervalSec: DigitalHumanConstants.POLL_INTERVAL_SEC,

  /** 单个 duix 任务超时（秒） */
  timeoutSec: DigitalHumanConstants.TIMEOUT_SEC,

  /** 连续失败次数上限，达到后熔断（容器挂了时不再让每条任务白等一轮超时） */
  maxCrashes: DigitalHumanConstants.MAX_CRASHES,

  /** 健康探测超时（ms） */
  healthTimeoutMs: DigitalHumanConstants.HEALTH_TIMEOUT_MS,

  // ---- 调度器参数 ----

  /** 数字人调度器轮询间隔（ms） */
  pollIntervalMs: DigitalHumanConstants.POLL_INTERVAL_MS,

  /**
   * 调度器在途任务数上限。
   *
   * duix 容器与 GPU 依旧是单实例串行，放大并发的收益来自**流水线重叠**：一条任务在
   * indexTTS 上配音时，另一条可在 duix 上对口型，两个 GPU 服务互不阻塞，故 2 是有意义的
   * 取值；再往上只会多出排队中的任务（两侧各自仍单任务），不会提高吞吐。默认 1 = 保持
   * 单飞（每次只跑一条）。
   */
  concurrency: DigitalHumanConstants.CONCURRENCY,

  /** leader 租约 TTL（ms），续期周期为 TTL/2 */
  leaseTtlMs: DigitalHumanConstants.LEASE_TTL_MS,

  /** 调度器 leader 租约键 */
  leaderKey: DigitalHumanConstants.LEADER_KEY,

  /**
   * 陈旧任务判定阈值（ms）。必须大于「配音 + 对口型」的总时长，
   * 否则中断恢复会把正在跑的长任务误判为孤儿。
   */
  taskStaleMs: DigitalHumanConstants.TASK_STALE_MS,

  /** 进度写库最小间隔（ms） */
  progressMinIntervalMs: DigitalHumanConstants.PROGRESS_MIN_INTERVAL_MS,

  /**
   * 配音阶段等待上限（ms）。须明显大于 INDEXTTS_JOB_TIMEOUT_MS —— 配音任务还可能排在
   * indexTTS 队列里等前面的任务，否则超长文本的合法配音会在完成前被数字人侧判为超时。
   */
  audioTimeoutMs: DigitalHumanConstants.AUDIO_TIMEOUT_MS,

  /**
   * 字幕阶段等待上限（ms）。
   *
   * 开启烧录时，数字人成片后会把配音音频交给字幕生成任务并等待其产出 SRT。
   * 须明显大于 SUBTITLE_TASK_STALE_MS（默认 30 分钟），否则合法的长字幕任务会被误判超时。
   */
  subtitleTimeoutMs: DigitalHumanConstants.SUBTITLE_TIMEOUT_MS,
} as const;

export default heygemConfig;
