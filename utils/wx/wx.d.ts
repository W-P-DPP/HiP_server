import {MEDIA_TYPES} from '../constant/wx.ts'

export interface IWxTokenResponse {
    access_token: string
    expires_in: number
}
export interface IWxAddMaterialResponse {
    /** 新增的永久素材 media_id */
    media_id: string
    /** 图片素材专属：图片 URL（腾讯系域名内可用） */
    url?: string
    /** 微信错误码（非 0 为失败） */
    errcode?: number
    /** 微信错误信息 */
    errmsg?: string
}

export interface IWxUploadImgResponse {
    /** 图文正文图片 URL（draft/add 正文仅接受该接口返回的 URL） */
    url?: string
    /** 微信错误码（非 0 为失败） */
    errcode?: number
    /** 微信错误信息 */
    errmsg?: string
}

export type WxMediaType = (typeof MEDIA_TYPES)[number];

export interface IWxResponse{
    errcode:number
    errmsg:string
}
export interface IWxGetResponse{
    description:string
    down_url:string
    title:string
    news_item:IWxMaterialItem[]
}
export interface IWxGetBathcResponse{
    total_count:number
    item_count:number
    item:IWxGetBathcContentItem[]
}
export interface IWxGetBathcContentItem{
    media_id:string
    update_time:string
    url:string
    update_time:number
    content:IWxMaterialItem[]
}

export interface IWxMaterialItem{
    title:string
    thumb_media_id:string
    author:string
    digest:string
    content:string
    url:string
    content_source_url:string
    show_cover_pic:number
}

export interface IWxMaterialCount{
    voice_count:number
    video_count:number
    image_count:number
    news_count:number
}
export interface IWxGetMediaResponse{
    /** 视频素材专属：临时素材视频 URL */
    video_url?: string
    /** 微信错误码（非 0 为失败；成功响应通常不包含该字段） */
    errcode?: number
    /** 微信错误信息 */
    errmsg?: string
}



export interface IWxDraftBatchget{
    offset:number
    count:number
    no_content?:number
}

export interface IWxDraftBatchgetResponse{
    total_count:number
    item_count:number
    item:IWxDraftBatchgetItem[]
}
export interface IWxDraftBatchgetItem{
    media_id:string
    content:IWxDraftBatchgetContent
    update_time:number
}
export interface IWxDraftBatchgetContent{
    news_item:(IWxDraft & {url:string})[]
}

export interface IWxFreePublishBatchget{
    offset:number
    count:number
    no_content?:number
}

export interface IWxFreePublishBatchgetResponse{
    total_count:number
    item_count:number
    item:IWxFreePublishBatchgetItem[]
}
export interface IWxFreePublishBatchgetItem{
    article_id:string
    content:IWxFreePublishBatchgetContent
    update_time:number
}
export interface IWxFreePublishBatchgetContent{
    news_item:(IWxDraft & {url:string; is_deleted:boolean})[]
}

export interface IWxDraftGet{
    media_id:string
}

export interface IWxDraftDelete{
    media_id:string
}

export interface IWxDraftGetResponse{
    news_item:(IWxDraft & {url:string})[]
}

export interface IWxDraftUpdate{
    media_id:string
    index:number
    articles:IWxDraft
}

export interface IWxDraft{
    product_info?:IWxProductInfo
    cover_info?:IWxCoverInfo
    image_info:IWxImageInfo
    title:string
    content:string
    content_source_url?:string
    thumb_media_id?:string
    article_type?:string
    author?:string
    digest?:string
    only_fans_can_comment?:number
    need_open_comment?:number
}
export interface IWxImageInfo{image_list:IWxImageList[]}
export interface IWxImageList{image_media_id:string}
// 封面信息，图文消息（news）和图片消息（newspic）均适用
export interface IWxCoverInfo{crop_percent_list:IWxCoverPercentList[]}
// 封面裁剪信息。以图片左上角（0,0）、右下角（1,1）建立平面坐标系，裁剪区域左上角坐标填入 x1、y1，右下角坐标填入 x2、y2
export interface IWxCoverPercentList{
    ratio:string
    x1:string
    y1:string
    x2:string
    x2:string
}
// 商品信息
export interface IWxProductInfo{footer_product_info:IWxFooterProductInfo[]}
// 文末插入商品相关信息
export interface IWxFooterProductInfo{
    product_key:string
}
export interface IWxDraftResponse {
    media_id:string
}

export interface IWxArticleRead{
    begin_date:string
    end_date:string
}

export interface IWxArticleReadResponse{
    is_delay?:boolean
    list:IWxArticleReadItem[]
}

export interface IWxArticleReadItem{
    ref_date:string
    msgid:string
    detail:IWxArticleReadDetail
}

export interface IWxArticleReadDetail{
    read_user:number
    read_user_source:IWxArticleReadSource[]
}

export interface IWxArticleReadSource{
    user_count:number
    scene_desc:string
}

export interface IWxArticleShare{
    begin_date:string
    end_date:string
}

export interface IWxArticleShareResponse{
    is_delay?:boolean
    list:IWxArticleShareItem[]
}

export interface IWxArticleShareItem{
    ref_date:string
    msgid:string
    detail:IWxArticleShareDetail
}

export interface IWxArticleShareDetail{
    share_user:number
}

export interface IWxBizSummary{
    begin_date:string
    end_date:string
}

export interface IWxBizSummaryResponse{
    is_delay?:boolean
    list:IWxBizSummaryItem[]
}

export interface IWxBizSummaryItem{
    ref_date:string
    detail:IWxBizSummaryDetail
}

export interface IWxBizSummaryDetail{
    read_user:number
    read_user_source:IWxArticleReadSource[]
    share_user:number
    zaikan_user:number
    like_user:number
    comment_count:number
    collection_user:number
    redirect_ori_page_user:number
    send_page_count:number
}

export interface IWxArticleTotalDetail{
    begin_date:string
    end_date:string
}

export interface IWxArticleTotalDetailResponse{
    is_delay?:boolean
    list:IWxArticleTotalDetailItem[]
}

export interface IWxArticleTotalDetailItem{
    ref_date:string
    msgid:string
    publish_type:number
    title:string
    content_url:string
    detail_list:IWxArticleTotalDetailRow[]
}

export interface IWxArticleTotalDetailRow{
    stat_date:string
    read_user:number
    read_user_source:IWxArticleReadSource[]
    share_user:number
    zaikan_user:number
    like_user:number
    comment_count:number
    collection_user:number
    praise_money:number
    read_subscribe_user:number
    read_delivery_rate:number
    read_finish_rate:number
    read_avg_activetime:number
}