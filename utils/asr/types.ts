// utils/asr/types.ts
/** 转写进度回调：pct 0..1，stage 为 ASCII key，message 为可直接展示的中文描述 */
export type AsrProgressHandler = (pct: number, stage: string, message: string) => void;

/** 单次转写入参 */
export interface AsrTranscribeOptions {
  /** 识别语种；讯飞传 'autodialect' 走自动语种，Whisper 侧会自动换成自身默认语种 */
  language?: string;
  /**
   * 幂等键（仅 Whisper 通道使用，讯飞按订单号走自己的语义）。
   *
   * 传业务侧的任务 id：重投（提交响应丢失、429 退避重试、中断任务续跑）不会重复消耗 GPU。
   */
  clientJobId?: string;
  /** 进度回调（可选） */
  onProgress?: AsrProgressHandler;
}

/** 转写结果：SRT 文本 + 实际生效的通道名 */
export interface AsrResult {
  srt: string;
  provider: string;
}

/**
 * ASR 通道契约：把本地音频绝对路径转成 SRT 文本。
 *
 * 与 `utils/indextts/IndexttsEngine.ts` 同思路 —— 接口就近声明，各实现自行封装传输细节，
 * 上层（subtitleDispatcher）只依赖本契约，从而支持「本地 Whisper 优先 + 云端讯飞兜底」的链路，
 * 单测也能注入假实现。
 */
export interface AsrProvider {
  readonly name: string;
  transcribeToSrt(audioAbs: string, opts?: AsrTranscribeOptions): Promise<AsrResult>;
}
