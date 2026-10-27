// utils/constant/LogConstants.ts
/** 日志（Winston + winston-daily-rotate-file）常量 */
import { envStr } from './envParse.ts';

export class LogConstants {
  /** 是否按日期切分日志（固定开启） */
  public static readonly ROTATE: boolean = true;

  /** 日志文件日期格式 */
  public static readonly DATE_PATTERN: string = 'YYYY-MM-DD';

  /** 日志文件保留时长（LOG_MAX_FILES，如 '1d' / '30d'）。缺省 365d */
  public static readonly MAX_FILES: string = envStr('LOG_MAX_FILES', '365d');
}
