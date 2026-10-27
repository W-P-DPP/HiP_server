// utils/asr/whisperProvider.ts
import { getWhisperClient } from '../whisper/WhisperHttpClient.ts';
import type { AsrProvider, AsrResult, AsrTranscribeOptions } from './types.ts';

/**
 * 本地 Whisper 通道（`auto` 链的**主路径**）。
 *
 * 自有 GPU、快且不计费，故优先；不可用时由链路的下一跳（云端讯飞）接手。
 * 进程内不加载模型 —— 真正的推理在独立 HTTP 服务里（本项目生产镜像为 Alpine，无 Python）。
 * 未部署服务时 `WhisperHttpClient` 会立刻抛「未配置」，上层链路的聚合错误会把它如实带出来。
 */
export class WhisperAsrProvider implements AsrProvider {
  readonly name = 'whisper';

  async transcribeToSrt(audioAbs: string, opts: AsrTranscribeOptions = {}): Promise<AsrResult> {
    const client = getWhisperClient();
    const { srt } = await client.transcribe(audioAbs, {
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.clientJobId ? { clientJobId: opts.clientJobId } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    return { srt, provider: this.name };
  }
}
