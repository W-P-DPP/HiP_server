import crypto from 'node:crypto';
import AxiosService from '../Axios.ts';
import RedisService from '../Redis.ts';
import { Logger } from '../Logger.ts';
import type { XunfeiTokenResponse } from './xunfei.d.ts'
import { XunfeiConstants } from '../constant/XunfeiConstants.ts'

const instance = AxiosService.getInstance();
const redis = RedisService.getInstance();
const logger = Logger.getInstance()

/**
 * 讯飞鉴权签名
 * 算法（官方文档：https://www.xfyun.cn/doc/spark/reproduction.html）：
 *   data    = {"base":{"appid":"<appId>","version":"v1","timestamp":"<timeStamp>"},"model":"remote"}
 *   keySign = md5(appKey + timeStamp)
 *   sign    = md5(keySign + data)
 *
 * @returns { sign, data } —— 签名与请求体共用同一时间戳，避免签名与请求体不一致
 */
const xunfei_sign = (): { sign: string; data: string } => {
    logger.info('加密sign')
    const appId = XunfeiConstants.APPID;
    const appKey = XunfeiConstants.API_KEY;
    const timeStamp = Date.now();
    const data = `{"base":{"appid":"${appId}","version":"v1","timestamp":"${timeStamp}"},"model":"remote"}`;
    const keySign = crypto.createHash('md5').update(`${appKey}${timeStamp}`).digest('hex');
    const sign = crypto.createHash('md5').update(`${keySign}${data}`).digest('hex');
    return { sign, data };
};


export const getToken = async (): Promise<string> => {
    logger.info('本地获取讯飞token')
    const cached = await redis.get('xunfei_token');
    if (cached) return cached;
    logger.info('云端获取讯飞token')
    const { sign, data } = xunfei_sign();
    const res = await instance.post<XunfeiTokenResponse>(XunfeiConstants.AUTH_URL, data, {
        headers: { 'Content-Type': 'application/json', Authorization: sign },
    });

    if (res.retcode !== '000000') {
        logger.error(`获取讯飞 token 失败，retcode=${res.retcode}`)
        throw new Error(`获取讯飞 token 失败，retcode=${res.retcode}`);
    }
    const token = res.accesstoken;
    if (!token) {
        logger.error(`获取讯飞 token 失败，retcode=${res.retcode}`)
        throw new Error('获取讯飞 token 失败：响应缺少 accesstoken');
    }
    logger.info('获取讯飞token成功')


    await redis.set('xunfei_token', token, 7080);
    return token;
};
