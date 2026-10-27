import OpenAI from 'openai';
import type { AIPlatform } from '../../type/index.d.ts';

/** 单个流式分片：content 为增量文本；finish 标记流结束（此时 content 恒为 ''） */
export interface ChatStreamChunk {
  content: string;
  finish: boolean;
}

/** 按凭证创建 OpenAI 兼容客户端（commandcode / deepseek 共用同一 SDK，仅 baseURL/apiKey 不同） */
export function createChatClient(credential: AIPlatform.Credential): OpenAI {
  return new OpenAI({
    apiKey: credential.apiKey,
    baseURL: credential.baseUrl,
  });
}

/**
 * 流式对话：逐块产出增量文本，末尾产出唯一的 finish 分片。
 * 传入 signal 以支持客户端断开时中止上游请求（调用方负责构造 AbortController）。
 */
export async function* streamChatCompletion(
  client: OpenAI,
  params: { model: string; messages: AIPlatform.ChatMessage[]; signal?: AbortSignal },
): AsyncGenerator<ChatStreamChunk> {
  const stream = await client.chat.completions.create(
    {
      model: params.model,
      messages: params.messages as OpenAI.Chat.ChatCompletionMessageParam[],
      stream: true,
    },
    params.signal ? { signal: params.signal } : undefined,
  );

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield { content: delta, finish: false };
  }

  yield { content: '', finish: true };
}
