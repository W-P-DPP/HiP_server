import type { AIPlatform } from '../../type/index.d.ts';

/**
 * 平台预设目录：展示名称 + 默认 baseUrl + 预设模型。
 * - 配置表单用它渲染可选平台与模型；
 * - provider.resolveBaseUrl 用它兜底 baseUrl（配置未显式覆盖时）。
 * commandcode 的模型清单在运行时动态拉取（见 utils/AIPlatform/provider.ts），此处留空。
 */
export const AI_PROVIDER_PRESETS: Record<
  AIPlatform.Provider,
  { label: string; baseUrl: string; presetModels: AIPlatform.Model[] }
> = {
  commandcode: {
    label: 'Command Code',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    presetModels: [],
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    presetModels: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', contextLength: 64000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextLength: 64000 },
    ],
  },
};

/** 全部支持的平台标识（顺序即展示顺序） */
export const AI_PROVIDERS: AIPlatform.Provider[] = ['commandcode', 'deepseek'];

/**
 * 用户维度「配置名称」部分唯一索引名（对应 entity 的 { userId, name } 唯一索引，flag:1 偏过滤）。
 * 并发创建命中重复键时，靠它从驱动错误里确认违反的是名称索引，而不是其他残留索引。
 */
export const AI_ACCOUNT_NAME_UNIQUE_INDEX = 'userId_1_name_1';

/** 兼容既有引用（utils/AIPlatform/cmdc/ListModel.ts 消费 cmdc.baseurl） */
export const cmdc = {
  baseurl: AI_PROVIDER_PRESETS.commandcode.baseUrl,
};
