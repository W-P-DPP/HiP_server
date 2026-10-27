// utils/constant/MaterialConstants.ts
/** 第三方素材（Pixabay / Pexels）与本地素材库匹配常量 */
import { envStr } from './envParse.ts';

export class MaterialConstants {
  /** Pixabay API key（PIXABAY_API_KEY）。留空则回退纯色背景 */
  public static readonly PIXABAY_API_KEY: string = envStr('PIXABAY_API_KEY');

  /** Pexels API key（PEXELS_API_KEY）。当前代码尚未消费，先归一化声明 */
  public static readonly PEXELS_API_KEY: string = envStr('PEXELS_API_KEY');

  /** 本地素材库相似度匹配阈值（0~1） */
  public static readonly MATCH_THRESHOLD: number = 0.6;
}
