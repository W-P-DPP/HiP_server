// utils/constant/OperationLogConstants.ts
/**
 * 操作日志常量。
 *
 * 注：当前代码尚无消费方（中间件未实现），此处先归一声明，待操作日志中间件落地时直接取用。
 */
import { envList } from './envParse.ts';

export class OperationLogConstants {
  /** 是否启用操作日志（固定开启） */
  public static readonly ENABLED: boolean = true;

  /** 操作日志白名单（OPERATION_LOG_WHITELIST，逗号分隔） */
  public static readonly WHITELIST: string[] = envList('OPERATION_LOG_WHITELIST');
}
