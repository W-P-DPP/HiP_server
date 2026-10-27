import type { WxAccount } from '../../type/index.d.ts';

/** 创建公众号配置入参 */
export type CreateWxAccountDto = WxAccount.CreateData;

/** 更新公众号配置入参（全部可选；appSecret 更新可选，不必全量重传） */
export type UpdateWxAccountDto = WxAccount.UpdateData;

/** 公众号配置查询参数（userId 恒为当前登录用户） */
export type WxAccountQueryDto = WxAccount.Query;
