// utils/whisper/whisper.config.ts
/** 本地 Whisper 客户端配置（环境变量读取点在 utils/constant/WhisperConstants.ts） */
import { WhisperConstants } from '../constant/WhisperConstants.ts';

/** 本地 Whisper 客户端配置（显式接口而非 `as const`，便于单测注入替身） */
export interface WhisperConfig {
  /** 运行模式：remote=调用独立部署的 Whisper 服务；off=禁用（默认） */
  mode: string;
  /** 服务地址（去掉尾部斜杠） */
  baseUrl: string;
  /** 鉴权 token，需与服务端 WHISPER_API_TOKEN 一致 */
  apiToken: string;
  /** 兜底默认语种（讯飞的 autodialect 对 Whisper 无意义） */
  language: string;
  /** 轮询任务状态的间隔（ms） */
  pollIntervalMs: number;
  /** 就绪等待超时（ms） */
  readyTimeoutMs: number;
  /** 单个任务超时（ms） */
  jobTimeoutMs: number;
  /** 是否可用：mode=remote 且配了 baseUrl 才算启用 */
  enabled: boolean;
}

/**
 * 本地 Whisper 配置（`auto` ASR 链的优先通道）。
 *
 * 默认 `off` —— 本项目生产镜像是 Alpine，无 Python，本地推理只能作为独立 HTTP 服务部署；
 * 未部署时保持 off，链路上就只剩讯飞那一跳（不会白跑一次注定失败的本地调用）。
 */
const whisperConfig: WhisperConfig = {
  mode: WhisperConstants.MODE,
  baseUrl: WhisperConstants.BASE_URL,
  apiToken: WhisperConstants.API_TOKEN,
  language: WhisperConstants.LANGUAGE,
  pollIntervalMs: WhisperConstants.POLL_INTERVAL_MS,
  readyTimeoutMs: WhisperConstants.READY_TIMEOUT_MS,
  jobTimeoutMs: WhisperConstants.JOB_TIMEOUT_MS,
  enabled: WhisperConstants.ENABLED,
};

export default whisperConfig;
