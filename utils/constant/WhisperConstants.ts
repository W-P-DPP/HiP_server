// utils/constant/WhisperConstants.ts
/**
 * 本地 Whisper（ASR 优先通道，services/whisper 独立 GPU 服务）常量。
 *
 * 恒走独立部署的 Whisper HTTP 服务；未部署时（BASE_URL 为空）链路上就只剩讯飞那一跳。
 */
import { envStr, stripTrailingSlash } from './envParse.ts';

const baseUrl = stripTrailingSlash(envStr('WHISPER_BASE_URL').trim());

export class WhisperConstants {
  /** 运行模式：remote=调用独立部署的 Whisper 服务；off=禁用 */
  public static readonly MODE: string = 'remote';

  /** 服务地址（去尾斜杠），仅 remote 模式使用 */
  public static readonly BASE_URL: string = baseUrl;

  /** 鉴权 token，需与服务端一致 */
  public static readonly API_TOKEN: string = envStr('WHISPER_API_TOKEN');

  /** 兜底默认语种（讯飞的 autodialect 对 Whisper 无意义） */
  public static readonly LANGUAGE: string = 'zh';

  /** 轮询任务状态的间隔（ms） */
  public static readonly POLL_INTERVAL_MS: number = 1_500;

  /** 就绪等待超时（ms） */
  public static readonly READY_TIMEOUT_MS: number = 600_000;

  /** 单个任务超时（ms） */
  public static readonly JOB_TIMEOUT_MS: number = 600_000;

  /** 是否可用：mode=remote 且配了 baseUrl 才启用 */
  public static readonly ENABLED: boolean = baseUrl !== '';
}
