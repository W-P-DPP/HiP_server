import { Logger } from '../Logger.ts';
import AxiosService from '../Axios.ts';
import { getToken } from './getToken.ts';
import type { TrainCreateParams, XunfeiTrainCreateResponse } from './xunfei.d.ts';
import { xunfei_sign } from './getTrainText.ts'
import { removeEmptyKeys } from '../tools.ts'
import { XunfeiConstants } from '../constant/XunfeiConstants.ts'
const instance = AxiosService.getInstance();
const logger = Logger.getInstance();

/** 创建训练任务的默认参数 */
const defaultParams: Required<Pick<TrainCreateParams, 'sex' | 'ageGroup' | 'resourceType' | 'denoise'>> = {
    sex: 1,
    ageGroup: 2,
    resourceType: 12, // 12: 一句话合成
    denoise: 0,
};

/**
 * 创建训练任务
 * 官方接口：POST /voice_train/task/add
 *
 * @param params 可选入参，覆盖默认值（空串/undefined 会被剔除，不随请求发送）
 * @returns      任务 id
 */
export const trainCreate = async (params: TrainCreateParams = {}): Promise<string> => {
    logger.info('创建训练任务')
    const appId = XunfeiConstants.APPID;
    const trainCreatetUrl = XunfeiConstants.TRAINTCREATE_URL;

    if (!appId || !trainCreatetUrl) {
        logger.error('创建训练任务失败：缺少 XUNFEI_APPID 或 XUNFEI_TRAINTCREATE_URL')
        throw new Error('创建训练任务失败：缺少 XUNFEI_APPID 或 XUNFEI_TRAINTCREATE_URL');
    }
    const token = await getToken();

    const body = {
        ...defaultParams,
        ...params,
        // 训练完成回调：未显式指定时默认走 XUNFEI_TRAIN_CALLBACK（env 为空时 removeEmptyKeys 会剔除）
        callbackUrl: params.callbackUrl || XunfeiConstants.TRAIN_CALLBACK,
    }
    const _body = JSON.stringify(removeEmptyKeys(body));
    const timeStamp = Date.now();
    const sign = xunfei_sign(timeStamp, _body);
    const res = await instance.post<XunfeiTrainCreateResponse>(trainCreatetUrl, _body, {
        headers: {
            'Content-Type': 'application/json',
            'X-Sign': sign,
            'X-Token': token,
            'X-AppId': appId,
            'X-Time': String(timeStamp),
        },
    });
    if (res.code !== 0) {
        logger.error(`创建训练任务失败：code=${res.code}，desc=${res.desc}`)
        throw new Error(`创建训练任务失败：code=${res.code}，desc=${res.desc}`);
    }
    logger.info('创建训练任务成功')
    return res.data;
}
