// utils/scenedetect/scenedetect.config.ts
/** 场景切分 HTTP 客户端配置（环境变量读取点在 utils/constant/scenedetect.ts） */
import { ScenedetectConstants } from '../constant/scenedetect.ts';

/** 场景切分客户端配置（显式接口而非 `as const`，便于单测注入替身） */
export interface ScenedetectConfig {
  /** 服务地址（去掉尾部斜杠） */
  baseUrl: string;
  /** 鉴权 token，需与 scenedetect 容器的 SCENEDETECT_API_TOKEN 一致 */
  apiToken: string;
  /** 是否启用：配了 SCENEDETECT_BASE_URL 才算启用 */
  enabled: boolean;
  /** 检测超时（ms），用作 HTTP 请求超时 */
  timeoutMs: number;
}

const scenedetectConfig: ScenedetectConfig = {
  baseUrl: ScenedetectConstants.BASE_URL,
  apiToken: ScenedetectConstants.API_TOKEN,
  enabled: ScenedetectConstants.ENABLED,
  timeoutMs: ScenedetectConstants.TIMEOUT_MS,
};

export default scenedetectConfig;
