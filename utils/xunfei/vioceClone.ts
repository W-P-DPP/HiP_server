import crypto from 'node:crypto';
import WebSocket from 'ws';
import { Logger } from '../Logger.ts';
import type { VoiceCloneParams, VoiceCloneResult, XunfeiCloneResponse } from './xunfei.d.ts';
import { XunfeiConstants } from '../constant/XunfeiConstants.ts';

const logger = Logger.getInstance();

/** 讯飞单帧文本 base64 上限（接口限制 8000 字节） */
const MAX_TEXT_BASE64 = 8000;
/**
 * 分片预算：约 1000 个中文字符（base64 ~4000）。
 * 实测讯飞合成耗时随文本近似线性增长（约 30ms/字），块太大单片耗时超长易超时，
 * 取较小分片控制单片合成时长（约 30-40s），并提升整体超时容忍度。
 */
const DEFAULT_MAX_TEXT_BYTES = 4000;
/** 单片合成超时（毫秒）：单片约 30-40s，留足余量 */
const DEFAULT_CHUNK_TIMEOUT = 120000;

/** 句子切分：中文标点 / 英文 !?; / 换行 / 英文句点+空格，分隔符归属前段 */
const SENTENCE_SPLIT_RE = /(?<=[。！？；…!?;\n]|\. )/;

/**
 * 生成讯飞音色克隆（voice_clone）WebSocket 鉴权 URL
 * 鉴权算法（官方文档：https://www.xfyun.cn/doc/spark/reproduction.html）：
 *   signature_origin = host: <host>\ndate: <date>\nGET <path> HTTP/1.1
 *   signature        = Base64(HMAC-SHA256(XUNFEI_APISecret, signature_origin))
 *   authorization    = Base64(api_key="<XUNFEI_APIKey>", algorithm="hmac-sha256",
 *                             headers="host date request-line", signature="<signature>")
 *   最终拼接 ?authorization=<urlencode>&date=<urlencode>&host=<urlencode>
 */
export const buildVoiceCloneAuthUrl = (): string => {
    logger.info('生成音色克隆鉴权URL')
    const appId = XunfeiConstants.APPID;
    const apiKey = XunfeiConstants.API_KEY;
    const apiSecret = XunfeiConstants.API_SECRET;
    const wsUrl = XunfeiConstants.VOICE_CLONE_URL;
    if (!appId || !apiKey || !apiSecret || !wsUrl) {
        logger.error('音色克隆合成失败：缺少 XUNFEI_APPID/XUNFEI_APIKey/XUNFEI_APISecret/XUNFEI_VOICE_CLONE_URL')
        throw new Error('音色克隆合成失败：缺少 XUNFEI_APPID/XUNFEI_APIKey/XUNFEI_APISecret/XUNFEI_VOICE_CLONE_URL');
    }

    const url = new URL(wsUrl);
    const host = url.host;
    const path = url.pathname;
    const date = new Date().toUTCString();

    const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
    const signature = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
    const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = Buffer.from(authorizationOrigin).toString('base64');

    return `${url.protocol}//${host}${path}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(host)}`;
};

/**
 * 长文本分片：按句子边界切分并贪心装箱，保证每块 base64 长度不超过 maxBase64Len。
 * 单句超限（超长无标点段）时按字节预算硬切兜底。
 *
 * @param text         待合成文本
 * @param maxBase64Len 单块 base64 长度上限，默认 7800（接口限制 8000，留裕量）
 * @returns            分片数组（空文本返回空数组）
 */
export const splitTextByBytes = (text: string, maxBase64Len = DEFAULT_MAX_TEXT_BYTES): string[] => {
    if (!text) return [];
    // 硬上限：不允许超过接口 8000 字节限制
    const cap = Math.min(maxBase64Len, MAX_TEXT_BASE64);

    const base64Len = (s: string): number => Buffer.from(s, 'utf8').toString('base64').length;

    // 硬切：把超长 segment 按字节预算切成小块
    const hardSplit = (seg: string): string[] => {
        if (base64Len(seg) <= cap) return [seg];
        const out: string[] = [];
        let buf = '';
        for (const ch of seg) {
            if (buf && base64Len(buf + ch) > cap) {
                out.push(buf);
                buf = ch;
            } else {
                buf += ch;
            }
        }
        if (buf) out.push(buf);
        return out;
    };

    const segments = text.split(SENTENCE_SPLIT_RE).filter(s => s.length > 0);
    const chunks: string[] = [];
    let current = '';
    const flush = (): void => {
        if (current) {
            chunks.push(current);
            current = '';
        }
    };

    for (const seg of segments) {
        for (const part of hardSplit(seg)) {
            if (current && base64Len(current + part) > cap) flush();
            current += part;
        }
    }
    flush();
    return chunks;
};

/**
 * 单片合成（status:2 一次性）：一条 WebSocket，text 需为单片（base64 ≤ 8000 字节）。
 * 音频以文本帧 payload.audio.audio（base64）逐块返回，payload.audio.status === 2 表示最后一块。
 * 结束后 ws.close() 优雅关闭，并兜底 terminate() 强关，避免连接悬挂。
 */
const synthChunk = (params: VoiceCloneParams): Promise<VoiceCloneResult> => {
    const appId = XunfeiConstants.APPID;
    const wsUrl = buildVoiceCloneAuthUrl();
    const encoding = params.encoding || 'lame';
    const sampleRate = params.sampleRate || 24000;

    const frame = JSON.stringify({
        header: { app_id: appId, res_id: params.resId, status: 2 },
        parameter: {
            tts: {
                vcn: params.vcn || 'x5_clone',
                LanguageID: params.LanguageID ?? 0,
                ...(params.speed != null ? { speed: params.speed } : {}),
                ...(params.volume != null ? { volume: params.volume } : {}),
                ...(params.pitch != null ? { pitch: params.pitch } : {}),
                ...(params.bgs != null ? { bgs: params.bgs } : {}),
                audio: { encoding, sample_rate: sampleRate },
            },
        },
        payload: {
            text: {
                text: Buffer.from(params.text, 'utf8').toString('base64'),
                encoding: 'utf8',
                status: 2,
            },
        },
    });

    return new Promise<VoiceCloneResult>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const audioChunks: Buffer[] = [];
        const timeoutMs = params.timeout || DEFAULT_CHUNK_TIMEOUT;
        let settled = false;
        let lastError: string | null = null;

        const finish = (action: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            action();
        };

        // 结束路径：先优雅 close，若服务端未回 close 帧则 1.5s 后 terminate 强关
        const closeSocket = (): void => {
            if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
            ws.close();
            const safety = setTimeout(() => {
                if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
            }, 1500);
            safety.unref();
        };

        const timer = setTimeout(() => {
            finish(() => {
                ws.terminate();
                reject(new Error('音色克隆合成超时'));
            });
        }, timeoutMs);

        ws.on('open', () => {
            logger.info('音色克隆 WebSocket 已连接，发送合成请求')
            ws.send(frame);
        });

        ws.on('message', (data, isBinary) => {
            // 二进制帧兜底：直接作为音频数据（ws 的 RawData 可能是 Buffer / ArrayBuffer / Buffer[]）
            if (isBinary) {
                const buf = Buffer.isBuffer(data)
                    ? data
                    : data instanceof ArrayBuffer
                        ? Buffer.from(data)
                        : Buffer.concat(data);
                audioChunks.push(buf);
                return;
            }

            // 文本帧：JSON 状态，音频块在 payload.audio.audio（base64）
            const raw = data.toString();
            let msg: XunfeiCloneResponse;
            try {
                msg = JSON.parse(raw) as XunfeiCloneResponse;
            } catch {
                logger.error(`音色克隆合成响应解析失败：${raw}`)
                return;
            }

            // 实测 code/message 位于 header 内，兼容顶层兜底
            const code = msg.header?.code ?? msg.code;
            if (code !== 0) {
                lastError = `音色克隆合成失败：code=${code}，message=${msg.header?.message ?? msg.message}`;
                logger.error(lastError)
                finish(() => {
                    ws.terminate();
                    reject(new Error(lastError!));
                });
                return;
            }

            // 累积 base64 音频块
            const audioB64 = msg.payload?.audio?.audio;
            if (audioB64) {
                audioChunks.push(Buffer.from(audioB64, 'base64'));
            }

            // 结束标志：payload.audio.status / header.status / data.status 任一为 2
            const status = msg.payload?.audio?.status ?? msg.header?.status ?? msg.data?.status ?? msg.status;
            if (status === 2) {
                logger.info('音色克隆合成完成')
                finish(() => {
                    closeSocket();
                    resolve({ audio: Buffer.concat(audioChunks), encoding, sampleRate });
                });
            }
        });

        ws.on('error', (err) => {
            lastError = `音色克隆合成 WebSocket 连接错误：${err.message}`;
            logger.error(lastError)
        });

        ws.on('close', (_code, reason) => {
            if (settled) return;
            finish(() => {
                if (lastError) {
                    reject(new Error(lastError));
                } else if (audioChunks.length > 0) {
                    logger.info('音色克隆合成完成（连接关闭）')
                    resolve({ audio: Buffer.concat(audioChunks), encoding, sampleRate });
                } else {
                    reject(new Error(reason ? `音色克隆合成失败：${reason}` : '音色克隆合成：未收到音频数据'));
                }
            });
        });
    });
};

/**
 * 音色克隆 · 音频合成（支持长文本）
 * 官方接口：wss://cn-huabei-1.xf-yun.com/v1/private/voice_clone
 *
 * 长文本按分片后**顺序多次单帧（status:2）合成再拼接**（单帧路径已实测可用），
 * 规避接口单帧 text base64 ≤8000 字节的限制。短文本（单片）直接单帧合成，行为不变。
 *
 * @param params.text   待合成文本（支持超 2000 字长文）
 * @param params.resId  训练得到的音色 id（必传）
 * @returns             合成音频 Buffer 与编码信息
 */
export const voiceCloneSynthesis = async (params: VoiceCloneParams): Promise<VoiceCloneResult> => {
    logger.info('音色克隆 音频合成')
    const encoding = params.encoding || 'lame';
    const sampleRate = params.sampleRate || 24000;
    const maxTextBytes = params.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;

    const chunks = splitTextByBytes(params.text, maxTextBytes);
    if (chunks.length === 0) {
        logger.error('音色克隆合成失败：text 为空')
        throw new Error('音色克隆合成失败：text 为空');
    }

    if (chunks.length === 1) {
        return synthChunk({ ...params, text: chunks[0]! });
    }

    logger.info(`音色克隆 长文本分片合成，共 ${chunks.length} 片`)
    const audios: Buffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
        logger.info(`音色克隆 合成分片 ${i + 1}/${chunks.length}`)
        const result = await synthChunk({ ...params, text: chunks[i]! });
        audios.push(result.audio);
    }
    return { audio: Buffer.concat(audios), encoding, sampleRate };
};
