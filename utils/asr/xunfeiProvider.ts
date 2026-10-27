// utils/asr/xunfeiProvider.ts
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '../Logger.ts';
import { arrast_result, arrast_upload } from '../xunfei/raast.ts';
import { parseRaasrSrt, RAASR_RESULT_TYPE, signatureRandomString } from '../xunfei/raasrHelpers.ts';
import type { RaasrGetResultResponse } from '../xunfei/xunfei.d.ts';
import asrConfig from './asr.config.ts';
import type { AsrProvider, AsrResult, AsrTranscribeOptions } from './types.ts';

const logger = Logger.getInstance();

/** 讯飞「任务处理中」的业务错误码（出现在错误消息里，而非响应体） */
const RAASR_PROCESSING_CODE = '26605';

/** 进度映射区间：订单轮询占整体 0.10 ~ 0.55，其余留给落库 */
const PROGRESS_MIN = 0.1;
const PROGRESS_SPAN = 0.45;

/** 按扩展名推断 MIME，供讯飞服务端转码参考（未知一律 octet-stream） */
function mimeFromName(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.ogg':
      return 'audio/ogg';
    case '.flac':
      return 'audio/flac';
    case '.webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

/**
 * 讯飞录音文件转写（大模型版 RAASR）通道。
 *
 * 上传 → 轮询 getResult → `parseRaasrSrt` 解析出 SRT。逻辑与
 * `voiceTrain.service.ts` 的 `uploadRaasrTranscription` + `pollRaasrResult` 同源，
 * 但独立实现 —— 不改动既有音色训练管道，避免回归风险。
 */
export class XunfeiAsrProvider implements AsrProvider {
  readonly name = 'xunfei';

  async transcribeToSrt(audioAbs: string, opts: AsrTranscribeOptions = {}): Promise<AsrResult> {
    if (!fs.existsSync(audioAbs)) {
      throw new Error(`音频文件不存在：${audioAbs}`);
    }
    const buffer = fs.readFileSync(audioAbs);
    const fileName = path.basename(audioAbs);
    const signatureRandom = signatureRandomString();

    const orderId = await arrast_upload(
      new File([new Uint8Array(buffer)], fileName, { type: mimeFromName(fileName) }),
      {
        fileSize: String(buffer.length),
        fileName,
        mimeType: mimeFromName(fileName),
        signatureRandom,
        ...(opts.language ? { language: opts.language } : {}),
      },
    );
    if (!orderId) throw new Error('讯飞语音转写：上传未返回订单号');

    const srt = await this.poll(orderId, signatureRandom, opts);
    return { srt, provider: this.name };
  }

  /** 轮询 getResult：status 4/1 完成返回 SRT；-1/2 失败抛错；其余继续等待 */
  private async poll(
    orderId: string,
    signatureRandom: string,
    opts: AsrTranscribeOptions,
  ): Promise<string> {
    const { pollIntervalMs, maxPollCount, maxConsecutiveErrors } = asrConfig;
    let consecutiveErrors = 0;

    for (let i = 0; i < maxPollCount; i += 1) {
      let content: RaasrGetResultResponse['content'];
      try {
        const res = await arrast_result(signatureRandom, orderId, RAASR_RESULT_TYPE);
        content = (res as unknown as RaasrGetResultResponse).content;
        consecutiveErrors = 0; // 成功响应重置连续错误计数
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes(RAASR_PROCESSING_CODE)) {
          // 任务处理中，属正常等待
          this.report(opts, i, maxPollCount, '语音识别中');
          await sleep(pollIntervalMs);
          continue;
        }
        // 网络抖动 / 5s 超时等：容忍连续若干次，避免偶发失败拖垮长轮询
        consecutiveErrors += 1;
        logger.warn(
          `[ASR:${this.name}] 轮询异常（第 ${i + 1}/${maxPollCount} 次，连续 ${consecutiveErrors} 次）：${msg}`,
        );
        if (consecutiveErrors >= maxConsecutiveErrors) throw err;
        await sleep(pollIntervalMs);
        continue;
      }

      const status = content?.orderInfo?.status;
      if (status === 4 || status === 1) {
        return content?.orderResult ? parseRaasrSrt(content.orderResult) : '';
      }
      if (status === -1 || status === 2) {
        const failType = content?.orderInfo?.failType;
        throw new Error(
          `讯飞语音转写失败：${failType != null && failType !== '' ? failType : `订单状态 ${status}`}`,
        );
      }
      // status 0/3：处理中，关闭此单（当前音频已处理完），继续轮询
      this.report(opts, i, maxPollCount, `语音识别中（第 ${i + 1} 次轮询）`);
      await sleep(pollIntervalMs);
    }

    throw new Error(`讯飞语音转写结果获取超时（已轮询 ${maxPollCount} 次）`);
  }

  /** 把轮询进度映射到 0.10 ~ 0.55，交给上层写库 */
  private report(
    opts: AsrTranscribeOptions,
    iteration: number,
    total: number,
    message: string,
  ): void {
    if (!opts.onProgress) return;
    const ratio = total > 0 ? Math.min(1, iteration / total) : 0;
    opts.onProgress(PROGRESS_MIN + ratio * PROGRESS_SPAN, 'asr', message);
  }
}
