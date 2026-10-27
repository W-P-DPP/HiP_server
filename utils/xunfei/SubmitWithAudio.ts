import { Logger } from '../Logger.ts';
import AxiosService from '../Axios.ts';
import { getToken } from './getToken.ts';
import type { SubmitWithAudioParams, XunfeiTrainCreateResponse } from './xunfei.d.ts';
import { xunfei_sign } from './getTrainText.ts'
import { buildMultipartBody } from './multipart.ts'
import { XunfeiConstants } from '../constant/XunfeiConstants.ts'
const instance = AxiosService.getInstance();
const logger = Logger.getInstance();

/**
 * 向训练任务添加音频（本地文件）并提交训练任务
 * 官方接口：POST /voice_train/task/submitWithAudio（multipart/form-data）
 * 注意：X-Sign 对整个 multipart body 签名（对齐官方 Python demo 对 formData 签名的方式），
 *       body 构建、Content-Type 头、签名三处共用同一个 boundary。
 *
 * @param params 音频文件（Buffer）与训练任务参数
 * @returns      响应 data（官方文档标注为 null，类型留 string | null 兜底）
 */
export const submitWithAudio = async (params: SubmitWithAudioParams): Promise<string | null> => {
    logger.info('向训练任务添加音频（本地文件）并提交训练任务')
    const appId = XunfeiConstants.APPID;
    const submitWithAudioUrl = XunfeiConstants.TRAINT_ADDSUBMIT_URL;

    if (!appId || !submitWithAudioUrl) {
        logger.error('向训练任务添加音频（本地文件）并提交训练任务：缺少 XUNFEI_APPID 或 XUNFEI_TRAINT_ADDSUBMIT_URL')
        throw new Error('向训练任务添加音频（本地文件）并提交训练任务：缺少 XUNFEI_APPID 或 XUNFEI_TRAINT_ADDSUBMIT_URL');
    }
    const token = await getToken();

    const { body, boundary } = buildMultipartBody({
        file: {
            name: 'file',
            fileName: params.fileName,
            mimeType: params.mimeType,
            buffer: params.fileBuffer,
        },
        fields: [
            { name: 'taskId', value: params.taskId },
            { name: 'textId', value: params.textId },
            { name: 'textSegId', value: params.textSegId },
            { name: 'mosRatio', value: params.mosRatio != null ? String(params.mosRatio) : '' },
        ],
    });

    const timeStamp = Date.now();
    const sign = xunfei_sign(timeStamp, body);
    const res = await instance.post<XunfeiTrainCreateResponse>(submitWithAudioUrl, body, {
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'X-Sign': sign,
            'X-Token': token,
            'X-AppId': appId,
            'X-Time': String(timeStamp),
        },
    });
    if (res.code !== 0) {
        logger.error(`向训练任务添加音频（本地文件）并提交训练任务：code=${res.code}，desc=${res.desc}`)
        throw new Error(`向训练任务添加音频（本地文件）并提交训练任务：code=${res.code}，desc=${res.desc}`);
    }
    logger.info('向训练任务添加音频（本地文件）并提交训练任务 成功')
    return res.data;
}
