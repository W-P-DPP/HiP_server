import type { AIPlatform } from '../../type/index.d.ts';

/** 创建 AI 平台配置入参 */
export type CreateAIPlatformDto = AIPlatform.AccountCreateData;

/** 更新 AI 平台配置入参（全部可选；apiKey 更新可选，不必全量重传） */
export type UpdateAIPlatformDto = AIPlatform.AccountUpdateData;

/** AI 平台配置查询参数（userId 恒为当前登录用户） */
export type AIPlatformQueryDto = AIPlatform.AccountQuery;
