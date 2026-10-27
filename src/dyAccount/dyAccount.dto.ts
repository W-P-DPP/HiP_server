import type { DyAccount } from '../../type/index.d.ts';

/** 创建抖音应用配置入参 */
export type CreateDyAccountDto = DyAccount.CreateData;

/** 更新抖音应用配置入参（全部可选；clientSecret 更新可选，不必全量重传） */
export type UpdateDyAccountDto = DyAccount.UpdateData;

/** 抖音应用配置查询参数（userId 恒为当前登录用户） */
export type DyAccountQueryDto = DyAccount.Query;
