import AxiosService from '../Axios.ts';
import { Logger } from '../Logger.ts';
import type { IWxFreePublishBatchget, IWxFreePublishBatchgetResponse, IWxResponse } from './wx.d.ts';
import { getToken } from './getToken.ts';
import { WX_BASE_URL } from '../constant/wx.ts';

const instance = AxiosService.getInstance();
const logger = Logger.getInstance();

// 获取已发布内容列表
export const freePublishBatchget = async (userId: string, info: IWxFreePublishBatchget) => {
    logger.info('公众号获取已发布内容列表 开始')
    if (info.offset == null) {
        logger.error('公众号获取已发布内容列表 失败:offset 为空')
        throw new Error("公众号获取已发布内容列表 失败:offset 为空")
    }
    if (!info.count) {
        logger.error('公众号获取已发布内容列表 失败:count 为空')
        throw new Error("公众号获取已发布内容列表 失败:count 为空")
    }
    if (info.count < 1 || info.count > 20) {
        logger.error('公众号获取已发布内容列表 失败:count 取值应在 1~20 之间')
        throw new Error("公众号获取已发布内容列表 失败:count 取值应在 1~20 之间")
    }
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/cgi-bin/freepublish/batchget"
    const res = await instance.post<IWxFreePublishBatchgetResponse & IWxResponse>(url, info, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号获取已发布内容列表 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号获取已发布内容列表 失败:${res.errcode}` + res.errmsg)
    }
    return res
}
