// utils/constant/scenedetect.ts
/**
 * PySceneDetect 场景切分常量。
 *
 * 恒走独立部署的 scenedetect HTTP 容器（见 services/scenedetect/README.md）：
 * 未配置 SCENEDETECT_BASE_URL 即视为未启用，调用时给出「服务未配置」的明确报错。
 */
import { envStr, stripTrailingSlash } from './envParse.ts';

/** 缺省检测算法：content / adaptive / threshold */
export const SCENE_DETECT_DEFAULT_DETECTOR = 'content';

/** 场景检测超时（ms）：HTTP 请求超时。 */
export const SCENE_DETECT_TIMEOUT_MS = 600_000;

const baseUrl = stripTrailingSlash(envStr('SCENEDETECT_BASE_URL').trim());

export class ScenedetectConstants {
  /** 服务地址（去尾斜杠） */
  public static readonly BASE_URL: string = baseUrl;

  /** 鉴权 token，需与 scenedetect 容器的 SCENEDETECT_API_TOKEN 一致 */
  public static readonly API_TOKEN: string = envStr('SCENEDETECT_API_TOKEN').trim();

  /** 是否启用：配了 SCENEDETECT_BASE_URL 才算启用 */
  public static readonly ENABLED: boolean = baseUrl !== '';

  /** 检测超时（ms）：入参 > 本值 */
  public static readonly TIMEOUT_MS: number = SCENE_DETECT_TIMEOUT_MS;

  /** 缺省检测算法（提交任务未指定、且请求参数也未给时兜底） */
  public static readonly DETECTOR: string = envStr('SCENEDETECT_DETECTOR', SCENE_DETECT_DEFAULT_DETECTOR);
}
