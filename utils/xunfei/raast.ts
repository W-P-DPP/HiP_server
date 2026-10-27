import crypto from 'node:crypto';
import { Logger } from '../Logger.ts';
import AxiosService from '../Axios.ts';
import type { RaasrGetResultResponse, RaasrResult, RaasrUploadParams, RaasrUploadResponse } from './xunfei.d.ts';
import { removeEmptyKeys } from '../tools.ts'
import type { string } from 'zod';
import { XunfeiConstants } from '../constant/XunfeiConstants.ts';

const instance = AxiosService.getInstance();
const logger = Logger.getInstance();


export const arrast_result = async (signatureRandom: string, orderId: string, resultType: string) => {
    logger.info('获取语音转写文件上传 结果')
    const appId = XunfeiConstants.APPID
    const accessKeyId = XunfeiConstants.API_KEY
    const _params = {
        appId,
        accessKeyId,
        signatureRandom,
        dateTime: getFormattedDateTime(),
        orderId,
        resultType
    }
    const res = await instance.post<RaasrUploadResponse>(XunfeiConstants.RAASR_RESULT_URL, {}, {
        headers: {
            'Content-Type': 'application/octet-stream',
            'signature': signature(_params)
        },
        params: _params
    })
    if (res.code !== '000000') {
        const errorMsg = `获取语音转写文件上传: [${res.code}] ${res.descInfo}`;
        logger.info('获取语音转写文件上传 失败' + res.descInfo)
        throw new Error(errorMsg);
    }
    logger.info('获取语音转写文件上传 成功')
    return res;
}

export const arrast_upload = async (file: File, upload_params: RaasrUploadParams) => {
    logger.info('语音转写文件上传')
    const appId = XunfeiConstants.APPID
    const accessKeyId = XunfeiConstants.API_KEY
    const _params = {
        ...upload_params,
        appId,
        accessKeyId,
        signatureRandom: upload_params.signatureRandom,
        fileSize: upload_params.fileSize,
        fileName: upload_params.fileName,
        language: upload_params.language || 'autodialect',
        dateTime: getFormattedDateTime(),
        durationCheckDisable:true

    }
    const query_params = removeEmptyKeys(_params)
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    const res = await instance.post<RaasrUploadResponse>(XunfeiConstants.RAASR_URL, fileBuffer, {
        headers: {
            'Content-Type': 'application/octet-stream',
            'signature': signature(query_params)
        },
        params: query_params
    })
    if (res.code !== '000000') {
        const errorMsg = `上传失败: [${res.code}] ${res.descInfo}`;
        logger.error('语音转写文件上传 失败' + res.descInfo)
        throw new Error(errorMsg);
    }
    logger.info('语音转写文件上传 成功')
    return res.content?.orderId;

}


export const signature = (params: Record<string, string | number | boolean>) => {
    logger.info('语音转写加密')
    const accessKeySecret = XunfeiConstants.API_SECRET
    const filteredParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== null && value !== undefined && value !== '') {
            filteredParams[key] = String(value);
        }
    }
    const sortedKeys = Object.keys(filteredParams).sort();
    const baseString = sortedKeys
        .map(key => {
            const encodedKey = encodeURIComponent(key);
            const encodedValue = encodeURIComponent(filteredParams[key] as string);
            return `${encodedKey}=${encodedValue}`;
        })
        .join('&');
    const hmac = crypto.createHmac('sha1', accessKeySecret);
    hmac.update(baseString, 'utf-8');
    const signature = hmac.digest('base64');
    return signature;
}










/** 生成随机串（大模型版鉴权参数 signatureRandom，取结果时必须复用上传时生成的值） */
const signatureRandomString = (length = 16): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) result += chars[bytes[i]! % chars.length];
    return result;
};

function getFormattedDateTime(): string {
    const now = new Date();
    // 转换为东八区时间
    const beijingTime = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const year = beijingTime.getFullYear();
    const month = pad(beijingTime.getMonth() + 1);
    const day = pad(beijingTime.getDate());
    const hours = pad(beijingTime.getHours());
    const minutes = pad(beijingTime.getMinutes());
    const seconds = pad(beijingTime.getSeconds());
    
    const result = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+0800`;
    return result;
}




