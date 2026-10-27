import { AI_PROVIDERS, AI_PROVIDER_PRESETS } from '../constant/AIPlatform.ts';
import type { AIPlatform } from '../../type/index.d.ts';

/** 是否为受支持的平台标识 */
export function isAIProvider(value: unknown): value is AIPlatform.Provider {
  return typeof value === 'string' && (AI_PROVIDERS as string[]).includes(value);
}

/** 解析 baseUrl：配置显式值优先，否则回退平台预设 */
export function resolveBaseUrl(provider: AIPlatform.Provider, override?: string): string {
  const trimmed = override?.trim();
  return trimmed ? trimmed : AI_PROVIDER_PRESETS[provider].baseUrl;
}

/**
 * 平台预设目录（GET /hip/api/aiPlatforms/providers 响应 data.list）。
 * commandcode 的模型清单运行时动态拉取（复用已有 listModels 的 Redis 缓存）；
 * 拉取失败降级为空清单，不阻断整个目录返回。
 */
export async function listProviderPresets(): Promise<AIPlatform.ProviderPreset[]> {
  // 动态引入：让纯函数（isAIProvider / resolveBaseUrl）不牵入 Axios/Redis 单例，便于单测与复用
  const { listModels } = await import('./cmdc/ListModel.ts');

  return Promise.all(
    AI_PROVIDERS.map(async (key): Promise<AIPlatform.ProviderPreset> => {
      const preset = AI_PROVIDER_PRESETS[key];

      let presetModels = preset.presetModels;
      if (key === 'commandcode') {
        try {
          presetModels = await listModels();
        } catch {
          presetModels = [];
        }
      }

      return { key, label: preset.label, baseUrl: preset.baseUrl, presetModels };
    }),
  );
}
