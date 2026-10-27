/** 数字人（HeyGem/Duix）业务常量 */
import { envInt, envStr, resolveFromCwd, stripTrailingSlash } from './envParse.ts';

/** 形象库参考视频在 file 表中的分类标识 */
export const DIGITAL_HUMAN_REFERENCE_CATEGORY = 'digitalHumanReference';

/** 数字人成片在 file 表中的分类标识 */
export const DIGITAL_HUMAN_VIDEO_CATEGORY = 'digitalHumanVideo';

/** 烧录字幕前的原始成片在 file 表中的分类标识（仅开启烧录时产生） */
export const DIGITAL_HUMAN_RAW_VIDEO_CATEGORY = 'digitalHumanRawVideo';

/**
 * 字幕烧录样式的服务端默认值（前端/MCP 未传时兜底）。
 *
 * 不含 marginV：上下边距的默认值由烧录方法按 position 决定（底部 24 / 顶部 16），
 * 避免两处维护同一份「按位置取值」的规则。
 */
export const DIGITAL_HUMAN_SUBTITLE_DEFAULTS = {
  fontSize: 24,
  fontName: 'Microsoft YaHei',
  colorHex: '#FFFFFF',
  outline: 1,
  position: 'bottom',
} as const;

/**
 * 交给 HeyGem 的音频统一采样率。
 *
 * duix 容器按 16kHz mono wav 处理驱动音频（见 JY_IPAgent 的 normalize_audio），
 * 而 IndexTTS 的产物采样率不固定，故 stage 前必须归一化。
 */
export const DIGITAL_HUMAN_AUDIO_SAMPLE_RATE = 16000;

/**
 * 参考视频时长边界（秒）。
 *
 * 过低没有足够的口型/动作参考，合成效果差；过高会显著拉长 duix 合成时间。
 * 与 JY_IPAgent `_validate_reference_video` 的 5–45s 口径一致。
 */
export const MIN_REFERENCE_VIDEO_DURATION_SEC = 5;
export const MAX_REFERENCE_VIDEO_DURATION_SEC = 45;

/** 候选产物 MP4 被视为完整的最小体积（字节） */
export const MIN_RESULT_MP4_BYTES = 100_000;

/** stage 进挂载目录后的音频/参考视频文件名（duix 侧按约定名读取） */
export const HEYGEM_AUDIO_FILE_NAME = 'audio.wav';
export const HEYGEM_MODEL_FILE_NAME = 'model.mp4';

/** 挂载目录下的子目录约定 */
export const HEYGEM_TASKS_SUBDIR = 'tasks';
export const HEYGEM_TEMP_SUBDIR = 'temp';
export const HEYGEM_RESULT_SUBDIR = 'result';

/**
 * 任务阶段中文标签。
 *
 * stage 在库里只存 ASCII key，中文映射集中在 Node 侧 —— 与 IndexTTS 的
 * `indexttsStageLabel` 同一策略，便于前端直接展示。
 */
const DIGITAL_HUMAN_STAGE_LABELS: Record<string, string> = {
  pending: '排队中',
  audio_submit: '提交配音',
  audio_synth: '配音合成中',
  heygem_stage: '准备素材',
  heygem_submit: '提交数字人',
  heygem_synth: '数字人合成中',
  subtitle_asr: '生成字幕中',
  subtitle_burn: '烧录字幕中',
  persist: '保存产物',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** ASCII stage key → 中文描述；未知 key 原样返回，便于排障时发现漏配 */
export function digitalHumanStageLabel(stage: string): string {
  return DIGITAL_HUMAN_STAGE_LABELS[stage] ?? stage;
}

/** 数字人（HeyGem/Duix）环境变量常量 */
export class DigitalHumanConstants {
  /** 总开关：false 时提交接口直接 503，形象库仍可用 */
  public static readonly ENABLED: boolean = true;
  /** duix/HeyGem HTTP 服务地址（去尾斜杠） */
  public static readonly BASE_URL: string = stripTrailingSlash(envStr('HEYGEM_BASE_URL', 'http://127.0.0.1:8383'));
  /** Node 可见的共享挂载目录（绝对路径） */
  public static readonly MOUNT_DIR: string = resolveFromCwd(envStr('HEYGEM_MOUNT_DIR', 'services/heygem/data'));
  /** duix 容器内对应 MOUNT_DIR 的前缀 */
  public static readonly CONTAINER_PREFIX: string = stripTrailingSlash(envStr('HEYGEM_CONTAINER_PREFIX', '/code/data'));
  /** 运行期目录（归一化音频与产物暂存） */
  public static readonly RUNTIME_DIR: string = resolveFromCwd('.runtime/digitalhuman');
  /** duix 提交参数：超分 / 水印 / 并行数 */
  public static readonly CHAOFEN: number = 0;
  public static readonly WATERMARK: number = 0;
  public static readonly PN: number = 1;
  /** 轮询 duix 任务状态的间隔（秒） */
  public static readonly POLL_INTERVAL_SEC: number = 2;
  /** 单个 duix 任务超时（秒） */
  public static readonly TIMEOUT_SEC: number = 3600;
  /** 连续失败次数上限（熔断） */
  public static readonly MAX_CRASHES: number = 3;
  /** 健康探测超时（ms） */
  public static readonly HEALTH_TIMEOUT_MS: number = envInt('HEYGEM_HEALTH_TIMEOUT_MS', 3_000);
  /** 调度器轮询间隔（ms） */
  public static readonly POLL_INTERVAL_MS: number = 1500;
  /** 调度器在途任务数上限 */
  public static readonly CONCURRENCY: number = 2;
  /** leader 租约 TTL（ms） */
  public static readonly LEASE_TTL_MS: number = 60_000;
  /** 调度器 leader 租约键 */
  public static readonly LEADER_KEY: string = envStr('DIGITALHUMAN_LEADER_KEY', 'wxbot:digitalhuman:leader');
  /** 陈旧任务判定阈值（ms） */
  public static readonly TASK_STALE_MS: number = 5_400_000;
  /** 进度写库最小间隔（ms） */
  public static readonly PROGRESS_MIN_INTERVAL_MS: number = 1000;
  /** 配音阶段等待上限（ms） */
  public static readonly AUDIO_TIMEOUT_MS: number = 4_200_000;
  /** 字幕阶段等待上限（ms） */
  public static readonly SUBTITLE_TIMEOUT_MS: number = 1_800_000;
}
