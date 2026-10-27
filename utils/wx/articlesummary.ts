import AxiosService from '../Axios.ts';
import { Logger } from '../Logger.ts';
import type { IWxResponse, IWxArticleRead, IWxArticleReadResponse, IWxArticleShare, IWxArticleShareResponse, IWxBizSummary, IWxBizSummaryResponse, IWxArticleTotalDetail, IWxArticleTotalDetailResponse } from './wx.d.ts';
import { getToken } from './getToken.ts';
import { WX_BASE_URL } from '../constant/wx.ts';

const instance = AxiosService.getInstance();
const logger = Logger.getInstance();

// 获取发表内容每日阅读数据
export const articleRead = async (userId: string, info: IWxArticleRead) => {
    logger.info('公众号获取发表内容每日阅读数据 开始')
    if (!info.begin_date) {
        logger.error('公众号获取发表内容每日阅读数据 失败:begin_date 为空')
        throw new Error("公众号获取发表内容每日阅读数据 失败:begin_date 为空")
    }
    if (!info.end_date) {
        logger.error('公众号获取发表内容每日阅读数据 失败:end_date 为空')
        throw new Error("公众号获取发表内容每日阅读数据 失败:end_date 为空")
    }
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/datacube/getarticleread"
    const res = await instance.post<IWxArticleReadResponse & IWxResponse>(url, info, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号获取发表内容每日阅读数据 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号获取发表内容每日阅读数据 失败:${res.errcode}` + res.errmsg)
    }
    return res
}

// 获取发表内容每日分享数据
export const articleShare = async (userId: string, info: IWxArticleShare) => {
    logger.info('公众号获取发表内容每日分享数据 开始')
    if (!info.begin_date) {
        logger.error('公众号获取发表内容每日分享数据 失败:begin_date 为空')
        throw new Error("公众号获取发表内容每日分享数据 失败:begin_date 为空")
    }
    if (!info.end_date) {
        logger.error('公众号获取发表内容每日分享数据 失败:end_date 为空')
        throw new Error("公众号获取发表内容每日分享数据 失败:end_date 为空")
    }
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/datacube/getarticleshare"
    const res = await instance.post<IWxArticleShareResponse & IWxResponse>(url, info, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号获取发表内容每日分享数据 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号获取发表内容每日分享数据 失败:${res.errcode}` + res.errmsg)
    }
    return res
}

// 获取发表内容概况总数据
export const bizSummary = async (userId: string, info: IWxBizSummary) => {
    logger.info('公众号获取发表内容概况总数据 开始')
    if (!info.begin_date) {
        logger.error('公众号获取发表内容概况总数据 失败:begin_date 为空')
        throw new Error("公众号获取发表内容概况总数据 失败:begin_date 为空")
    }
    if (!info.end_date) {
        logger.error('公众号获取发表内容概况总数据 失败:end_date 为空')
        throw new Error("公众号获取发表内容概况总数据 失败:end_date 为空")
    }
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/datacube/getbizsummary"
    const res = await instance.post<IWxBizSummaryResponse & IWxResponse>(url, info, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号获取发表内容概况总数据 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号获取发表内容概况总数据 失败:${res.errcode}` + res.errmsg)
    }
    return res
}

// 获取发表内容发表详细数据
export const articleTotalDetail = async (userId: string, info: IWxArticleTotalDetail) => {
    logger.info('公众号获取发表内容发表详细数据 开始')
    if (!info.begin_date) {
        logger.error('公众号获取发表内容发表详细数据 失败:begin_date 为空')
        throw new Error("公众号获取发表内容发表详细数据 失败:begin_date 为空")
    }
    if (!info.end_date) {
        logger.error('公众号获取发表内容发表详细数据 失败:end_date 为空')
        throw new Error("公众号获取发表内容发表详细数据 失败:end_date 为空")
    }
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/datacube/getarticletotaldetail"
    const res = await instance.post<IWxArticleTotalDetailResponse & IWxResponse>(url, info, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号获取发表内容发表详细数据 失败:${res.errcode} ` + res.errmsg)
        throw new Error(`公众号获取发表内容发表详细数据 失败:${res.errcode} ` + res.errmsg)
    }
    return res
}
