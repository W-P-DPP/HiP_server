import { Logger } from '../Logger.ts';
import AxiosService from '../Axios.ts';
import { getToken } from './getToken.ts';
import type { XunfeiTrainResultResponse } from './xunfei.d.ts';
import { xunfei_sign } from './getTrainText.ts'
import { XunfeiConstants } from '../constant/XunfeiConstants.ts'
const instance = AxiosService.getInstance();
const logger = Logger.getInstance();

export const getTrainResult = async (taskId: string) => {
    logger.info('获取训练结果')
    const appId = XunfeiConstants.APPID;
    const resultUrl = XunfeiConstants.TRAINT_RESULT_URL;
    if (!appId || !resultUrl) {
        logger.error('获取训练结果 失败：缺少 XUNFEI_APPID 或 XUNFEI_TRAINT_RESULT_URL')
        throw new Error('获取训练结果 失败：缺少 XUNFEI_APPID 或 XUNFEI_TRAINT_RESULT_URL');
    }

    const token = await getToken();
    const body = {
        taskId
    }
    const _body = JSON.stringify(body);
    const timeStamp = Date.now();
    const sign = xunfei_sign(timeStamp, _body);
    const res = await instance.post<XunfeiTrainResultResponse>(resultUrl, body, {
        headers: {
            'Content-Type': 'application/json',
            'X-Sign': sign,
            'X-Token': token,
            'X-AppId': appId,
            'X-Time': String(timeStamp),
        },
    });
    if (res.code !== 0) {
        logger.error(`获取训练结果 失败：code=${res.code}，desc=${res.desc}`)
        throw new Error(`获取训练结果 失败：code=${res.code}，desc=${res.desc}`);
    }
    logger.info('获取训练结果 成功')
    return res.data;
}