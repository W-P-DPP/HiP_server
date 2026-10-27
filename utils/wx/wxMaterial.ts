import AxiosService from '../Axios.ts';
import { Logger } from '../Logger.ts';
import type { IWxAddMaterialResponse, WxMediaType, IWxResponse, IWxGetResponse, IWxGetBathcResponse, IWxMaterialCount, IWxGetMediaResponse, IWxUploadImgResponse } from './wx.d.ts';
import { getToken } from './getToken.ts';
import { prepareContentImage } from './contentImage.ts';
import fs from 'fs';
import path from 'path';
import { MIME_MAP, MEDIA_TYPES, WX_BASE_URL } from '../constant/wx.ts'

const instance = AxiosService.getInstance();
const logger = Logger.getInstance();


// 新增素材
export const addMaterial = async (
    userId: string,
    type: WxMediaType,
    filePath: string,
    description?: { title: string; introduction: string },
): Promise<IWxAddMaterialResponse> => {
    logger.info('云端添加公众号素材 开始');
    if (!MEDIA_TYPES.includes(type)) {
        logger.error('type 参数不合法，仅支持 image/voice/video/thumb');
        throw new Error('type 参数不合法，仅支持 image/voice/video/thumb');
    }
    if (!fs.existsSync(filePath)) {
        logger.error(`文件不存在：${filePath}`);
        throw new Error(`文件不存在：${filePath}`);
    }
    if (type === 'video' && !description) {
        logger.error('type 为 video 时 description 必传');
        throw new Error('type 为 video 时 description 必传');
    }

    const access_token = await getToken(userId);
    const url = WX_BASE_URL + '/cgi-bin/material/add_material';

    const form = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mime = MIME_MAP[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
    form.append('media', new Blob([fileBuffer], { type: mime }), fileName);
    if (type === 'video' && description) {
        form.append('description', JSON.stringify(description));
    }

    const res = await instance.post<IWxAddMaterialResponse>(url, form, {
        params: { access_token, type },
        timeout: 60_000,
    });

    if (res.errcode) {
        logger.error(`云端添加公众号素材 失败：${res.errcode} ${res.errmsg}`);
        throw new Error(`微信接口错误（${res.errcode}）：${res.errmsg}`);
    }

    logger.info('云端添加公众号素材 成功');
    return res;
};


// 删除素材
export const delMaterial = async (userId: string, media_id: string) => {
    logger.info('云端删除公众号素材 开始');
    if (!media_id) {
        logger.error('media_id 缺失，删除失败');
        throw new Error('media_id 缺失，删除失败');
    }
    const access_token = await getToken(userId);
    const url = WX_BASE_URL + '/cgi-bin/material/del_material';
    const res = await instance.post<IWxResponse>(url, {
        media_id
    }, {
        params: { access_token },
    });

    if (res.errcode) {
        logger.error(`云端删除公众号素材 失败：${res.errcode} ${res.errmsg}`);
        throw new Error(`微信接口错误（${res.errcode}）：${res.errmsg}`);
    }
    logger.info('云端删除公众号素材 成功');

    return res
}

// 获取永久素材
export const getMaterial = async (userId: string, media_id: string) => {
    logger.info('云端获取永久素材 开始');
    if (!media_id) {
        logger.error('media_id 缺失，获取失败');
        throw new Error('media_id 缺失，获取失败');
    }
    const access_token = await getToken(userId);
    const url = WX_BASE_URL + '/cgi-bin/material/get_material';
    const res = await instance.post<IWxGetResponse & IWxResponse>(url, {
        media_id
    }, {
        params: { access_token },
    });

    if (res.errcode) {
        logger.error(`云端获取永久素材材 失败：${res.errcode} ${res.errmsg}`);
        throw new Error(`微信接口错误（${res.errcode}）：${res.errmsg}`);
    }
    logger.info('云端获取永久素材 成功');

    return res
}
// 获取永久素材列表 count 返回素材的数量，取值在1到20之间
export const batchGetMaterial = async (userId: string, type: WxMediaType | 'news', offset: number, count: number) => {
    logger.info('云端获取永久素材列表 开始');
    if (!type || typeof offset !== 'number' || !count) {
        logger.error('参数缺失，获取失败');
        throw new Error('参数缺失，获取失败');
    }
    const access_token = await getToken(userId);
    const url = WX_BASE_URL + '/cgi-bin/material/batchget_material';
    const res = await instance.post<IWxGetBathcResponse & IWxResponse>(url, {
        type, offset, count
    }, {
        params: { access_token },
    });

    if (res.errcode) {
        logger.error(`云端获取永久素材材列表 失败：${res.errcode} ${res.errmsg}`);
        throw new Error(`微信接口错误（${res.errcode}）：${res.errmsg}`);
    }
    logger.info('云端获取永久素材列表 成功');

    return res
}

// 获取永久素材总数
export const getMaterialCount = async (userId: string) => {
    logger.info('云端获取永久素材总数 开始');

    const access_token = await getToken(userId);
    const url = WX_BASE_URL + '/cgi-bin/material/get_materialcount';
    const res = await instance.get<IWxMaterialCount & IWxResponse>(url, {
        params: { access_token },
    });

    if (res.errcode) {
        logger.error(`云端获取永久素材总数 失败：${res.errcode} ${res.errmsg}`);
        throw new Error(`微信接口错误（${res.errcode}）：${res.errmsg}`);
    }
    logger.info('云端获取永久素材总数 成功');
    return res
}

// 获取临时素材
export const getMedia = async (userId: string, media_id: string) => {
    logger.info('云端获取临时素材 开始');
    if (!media_id) {
        logger.error('media_id 缺失，获取失败');
        throw new Error('media_id 缺失，获取失败');
    }
    const access_token = await getToken(userId);
    const url = WX_BASE_URL + '/cgi-bin/media/get';
    const res = await instance.get<IWxGetMediaResponse>(url, {
        params: { access_token, media_id },
    });

    if (res.errcode) {
        logger.error(`云端获取临时素材材 失败：${res.errcode} ${res.errmsg}`);
        throw new Error(`微信接口错误（${res.errcode}）：${res.errmsg}`);
    }
    logger.info('云端获取临时素材 成功');

    return res
}

// 新增临时素材
export const uploadTempMedia = async (
    userId: string,
    type: WxMediaType,
    filePath: string,
    description?: { title: string; introduction: string },
): Promise<IWxAddMaterialResponse> => {
    logger.info('云端添加公众号临时素材 开始');
    if (!MEDIA_TYPES.includes(type)) {
        logger.error('type 参数不合法，仅支持 image/voice/video/thumb');
        throw new Error('type 参数不合法，仅支持 image/voice/video/thumb');
    }
    if (!fs.existsSync(filePath)) {
        logger.error(`文件不存在：${filePath}`);
        throw new Error(`文件不存在：${filePath}`);
    }
    if (type === 'video' && !description) {
        logger.error('type 为 video 时 description 必传');
        throw new Error('type 为 video 时 description 必传');
    }

    const access_token = await getToken(userId);
    const url = WX_BASE_URL + '/cgi-bin/media/upload';

    const form = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mime = MIME_MAP[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
    form.append('media', new Blob([fileBuffer], { type: mime }), fileName);
    if (type === 'video' && description) {
        form.append('description', JSON.stringify(description));
    }

    const res = await instance.post<IWxAddMaterialResponse>(url, form, {
        params: { access_token, type },
        timeout: 60_000,
    });

    if (res.errcode) {
        logger.error(`云端添加公众号临时素材 失败：${res.errcode} ${res.errmsg}`);
        throw new Error(`微信接口错误（${res.errcode}）：${res.errmsg}`);
    }

    logger.info('云端添加公众号 临时 素材 成功');
    return res;
};

/**
 * 上传图文消息内的图片，返回正文可用 URL。
 * draft/add 正文图片只接受本接口返回的 URL，外部 URL 会被过滤；
 * 图片仅支持 jpg/png 且必须小于 1MB，超限图片先用 ffmpeg 压缩到临时文件再上传。
 */
export const uploadContentImage = async (userId: string, filePath: string): Promise<string> => {
    logger.info('云端上传图文消息内图片 开始');
    const prepared = await prepareContentImage(filePath);
    try {
        const access_token = await getToken(userId);
        const url = WX_BASE_URL + '/cgi-bin/media/uploadimg';

        const form = new FormData();
        const fileBuffer = fs.readFileSync(prepared.filePath);
        const fileName = path.basename(prepared.filePath);
        const mime = MIME_MAP[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
        form.append('media', new Blob([fileBuffer], { type: mime }), fileName);

        const res = await instance.post<IWxUploadImgResponse>(url, form, {
            params: { access_token },
            timeout: 60_000,
        });

        if (res.errcode || !res.url) {
            logger.error(`云端上传图文消息内图片 失败：${res.errcode} ${res.errmsg}`);
            throw new Error(`微信接口错误（${res.errcode ?? '未知'}）：${res.errmsg ?? '未返回图片 URL'}`);
        }

        logger.info('云端上传图文消息内图片 成功');
        return res.url;
    } finally {
        if (prepared.temporary) fs.rmSync(prepared.filePath, { force: true });
    }
};
