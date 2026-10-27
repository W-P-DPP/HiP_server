// utils/asr/index.ts
import { Logger } from '../Logger.ts';
import asrConfig, { type AsrProviderName } from './asr.config.ts';
import whisperConfig from '../whisper/whisper.config.ts';
import { XunfeiAsrProvider } from './xunfeiProvider.ts';
import { WhisperAsrProvider } from './whisperProvider.ts';
import type { AsrProvider, AsrResult, AsrTranscribeOptions } from './types.ts';

const logger = Logger.getInstance();

export type { AsrProgressHandler, AsrProvider, AsrResult, AsrTranscribeOptions } from './types.ts';
export { XunfeiAsrProvider } from './xunfeiProvider.ts';
export { WhisperAsrProvider } from './whisperProvider.ts';

/**
 * `auto` 链的通道优先级：**本地 Whisper 优先，云端讯飞兜底**。
 *
 * 抽成纯函数：这条策略只有一处定义，单测也不必依赖 env。
 * 本地未部署（WHISPER_MODE=off / 未配 BASE_URL）时不发这一跳 —— 否则每次转写都先失败一次，
 * 还多一条误导性的「whisper 通道失败」告警。
 */
export function orderedAsrProviders(localEnabled: boolean): AsrProviderName[] {
  return localEnabled ? ['whisper', 'xunfei'] : ['xunfei'];
}

/**
 * 按配置组装 ASR 通道链（顺序即尝试顺序）。
 *
 * - `auto`（默认）：本地 Whisper 优先 + 云端讯飞兜底（本地未部署时只剩讯飞）
 * - `xunfei` / `whisper`：只用指定通道，便于排障与灰度
 */
export function resolveAsrChain(provider: AsrProviderName = asrConfig.provider): AsrProvider[] {
  switch (provider) {
    case 'xunfei':
      return [new XunfeiAsrProvider()];
    case 'whisper':
      return [new WhisperAsrProvider()];
    default:
      return orderedAsrProviders(whisperConfig.enabled).map(name =>
        name === 'whisper' ? new WhisperAsrProvider() : new XunfeiAsrProvider(),
      );
  }
}

/**
 * 音频 → SRT：沿通道链依次尝试，任一成功即返回。
 *
 * 逐通道降级而非「一次失败就整体失败」：本地 Whisper 走自有 GPU，快且不计费，故当主路径；
 * 服务未部署/不可用时降级到云端讯飞，避免把任务卡死在本地环境上。全部失败抛聚合错误，
 * 逐条带上失败原因，避免「所有通道都失败」这种无法排障的信息。
 *
 * @param chain 显式指定通道链（单测注入假 provider）；缺省按配置组装
 */
export async function transcribeToSrt(
  audioAbs: string,
  opts: AsrTranscribeOptions = {},
  chain?: AsrProvider[],
): Promise<AsrResult> {
  const providers = chain ?? resolveAsrChain();
  if (providers.length === 0) throw new Error('未配置任何 ASR 通道');

  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const result = await provider.transcribeToSrt(audioAbs, opts);
      if (provider !== providers[0]) {
        logger.warn(`[ASR] 已降级到 ${provider.name} 通道完成转写`);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${provider.name}: ${message}`);
      logger.warn(`[ASR] ${provider.name} 通道转写失败，尝试下一通道：${message}`);
    }
  }

  throw new Error(`所有 ASR 通道均失败：${failures.join('；')}`);
}
