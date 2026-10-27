import AxiosService from '../Axios.ts';
import { Logger } from '../Logger.ts';
import type { IWxDraft, IWxDraftResponse, IWxResponse, IWxDraftUpdate, IWxDraftBatchget, IWxDraftBatchgetResponse, IWxDraftGet, IWxDraftGetResponse, IWxDraftDelete } from './wx.d.ts';
import { getToken } from './getToken.ts';
import { WX_BASE_URL } from '../constant/wx.ts';

const instance = AxiosService.getInstance();
const logger = Logger.getInstance();

// 获取草稿列表
export const draftBatchget = async (userId: string, info: IWxDraftBatchget) => {
    logger.info('公众号获取草稿列表 开始')
    if (info.offset == null) {
        logger.error('公众号获取草稿列表 失败:offset 为空')
        throw new Error("公众号获取草稿列表 失败:offset 为空")
    }
    if (!info.count) {
        logger.error('公众号获取草稿列表 失败:count 为空')
        throw new Error("公众号获取草稿列表 失败:count 为空")
    }
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/cgi-bin/draft/batchget"
    const res = await instance.post<IWxDraftBatchgetResponse & IWxResponse>(url, info, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号获取草稿列表 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号获取草稿列表 失败:${res.errcode}` + res.errmsg)
    }
    return res
}

// 获取草稿总数
export const draftCount = async (userId: string) => {
    logger.info('公众号获取草稿总数 开始')
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/cgi-bin/draft/count"
    const res = await instance.get<{ total_count: number } & IWxResponse>(url, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号获取草稿总数 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号获取草稿总数 失败:${res.errcode}` + res.errmsg)
    }
    return res
}


// 获取草稿详情
export const draftGet = async (userId: string, info: IWxDraftGet) => {
    logger.info('公众号获取草稿详情 开始')
    if (!info.media_id) {
        logger.error('公众号获取草稿详情 失败:media_id 为空')
        throw new Error("公众号获取草稿详情 失败:media_id 为空")
    }
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/cgi-bin/draft/get"
    const res = await instance.post<IWxDraftGetResponse & IWxResponse>(url, info, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号获取草稿详情 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号获取草稿详情 失败:${res.errcode}` + res.errmsg)
    }
    return res
}

// 删除草稿
export const draftDelete = async (userId: string, info: IWxDraftDelete) => {
    logger.info('公众号删除草稿 开始')
    if (!info.media_id) {
        logger.error('公众号删除草稿 失败:media_id 为空')
        throw new Error("公众号删除草稿 失败:media_id 为空")
    }
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/cgi-bin/draft/delete"
    const res = await instance.post<IWxResponse>(url, info, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号删除草稿 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号删除草稿 失败:${res.errcode}` + res.errmsg)
    }
    return res
}

// 新增草稿
export const draftAdd = async (userId: string, articles: IWxDraft) => {
    logger.info('公众号新增草稿 开始')
    valiArticlesInfo(articles)
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/cgi-bin/draft/add"
    // 微信 draft/add 请求体要求 articles 为数组（{ articles: [...] }），不能直接传单对象
    const res = await instance.post<IWxDraftResponse & IWxResponse>(url, { articles: [articles] }, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号新增草稿 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号新增草稿 失败:${res.errcode}` + res.errmsg)
    }
    return res
}

// 更新草稿
export const draftUpdate = async (userId: string, info: IWxDraftUpdate) => {
    logger.info('公众号更新草稿 开始')
    valiArticlesInfo(info.articles)
    const access_token = await getToken(userId)
    const url = WX_BASE_URL + "/cgi-bin/draft/update"
    const res = await instance.post<IWxResponse>(url, info, {
        params: { access_token }
    })
    if (res.errcode) {
        logger.error(`公众号更新草稿 失败:${res.errcode}` + res.errmsg)
        throw new Error(`公众号更新草稿 失败:${res.errcode}` + res.errmsg)
    }
    return res
}

const valiArticlesInfo = (articles: IWxDraft) => {
    if (!articles.title) {
        logger.error('公众号草稿 失败:title 为空')
        throw new Error("公众号草稿 失败:title 为空")
    }
    if (!articles.content) {
        logger.error('公众号草稿 失败:content 为空')
        throw new Error("公众号草稿 失败:content 为空")
    }
    if (!articles.image_info.image_list.length) {
        logger.error('公众号草稿 失败:image 为空')
        throw new Error("公众号草稿 失败:image 为空")
    }
}
