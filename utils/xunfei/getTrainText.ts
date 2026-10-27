import { Logger } from '../Logger.ts';
import AxiosService from '../Axios.ts';
import RedisService from '../Redis.ts';
import { getToken } from './getToken.ts';
import type { XunfeiTrainTextData, XunfeiTrainTextResponse } from './xunfei.d.ts';
import crypto from 'node:crypto';
import { XunfeiConstants } from '../constant/XunfeiConstants.ts';

const instance = AxiosService.getInstance();
const redis = RedisService.getInstance();
const logger = Logger.getInstance();

/**
 * 音色训练接口签名（官方文档：https://www.xfyun.cn/doc/spark/reproduction.html）：
 *   X-Sign = MD5(apikey + X-Time + MD5(body))，值为 32 位小写
 * 其中 apikey 为鉴权用的 XUNFEI_APIKey，X-Time 为请求头与签名共用的 Unix 毫秒时间戳，body 为请求体原始字符串。
 *
 * @param timeStamp 与请求头 X-Time 共用的时间戳，避免签名与请求不一致
 * @param body      请求体原始字符串或 multipart 请求体 Buffer
 * @returns         32 位小写 md5 签名
 */
export const xunfei_sign = (timeStamp: number, body: string | Buffer): string => {
    logger.info('加密sign')
    const appKey = XunfeiConstants.API_KEY;
    if (!appKey) {
        logger.error('加密sign失败：缺少 XUNFEI_APIKey')
        throw new Error('加密sign失败：缺少 XUNFEI_APIKey');
    }
    const md5Body = crypto.createHash('md5').update(body).digest('hex');
    return crypto.createHash('md5').update(`${appKey}${timeStamp}${md5Body}`).digest('hex');
};

/**
 * 获取云端训练样本（训练文本列表）
 * 官方文档：https://www.xfyun.cn/doc/spark/reproduction.html
 * 接口：POST /voice_train/task/traintext，body 传 textId（使用通用训练文本 textId=5001）。
 *
 * @param textId 训练文本ID，默认使用通用训练文本 5001
 * @returns      训练文本数据（textId、textName、textSegs）
 */
export const getTrainText = async (textId = XunfeiConstants.TEXTID): Promise<XunfeiTrainTextData> => {
    // 缓存 key：不同训练文本区分缓存
    const cacheKey = `xunfei_train_text:${textId}`;
    // 先从 Redis 缓存取（有效期两小时），命中则直接返回
    const cached = await redis.getJSON<XunfeiTrainTextData>(cacheKey);
    if (cached) {
        logger.info('获取训练样本：命中缓存 ' + textId)
        return cached;
    }
    logger.info('获取云端训练样本 ' + textId)
    const token = await getToken();
    const appId = XunfeiConstants.APPID;
    const trainTextUrl = XunfeiConstants.TRAINTEXT_URL;
    if (!appId || !trainTextUrl) {
        logger.error('获取云端训练样本失败：缺少 XUNFEI_APPID 或 XUNFEI_TRAINTEXT_URL')
        throw new Error('获取云端训练样本失败：缺少 XUNFEI_APPID 或 XUNFEI_TRAINTEXT_URL');
    }

    const body = JSON.stringify({ textId });
    const timeStamp = Date.now();
    const sign = xunfei_sign(timeStamp, body);

    const res = await instance.post<XunfeiTrainTextResponse>(trainTextUrl, body, {
        headers: {
            'Content-Type': 'application/json',
            'X-Sign': sign,
            'X-Token': token,
            'X-AppId': appId,
            'X-Time': String(timeStamp),
        },
    });

    if (res.code !== 0) {
        logger.error(`获取云端训练样本失败，code=${res.code}，desc=${res.desc}`)
        throw new Error(`获取云端训练样本失败，code=${res.code}，desc=${res.desc}`);
    }
    logger.info('获取云端训练样本成功')
    // 写回 Redis 缓存，有效期两小时
    await redis.setJSON(cacheKey, res.data, 2 * 60 * 60);
    return res.data;
};
