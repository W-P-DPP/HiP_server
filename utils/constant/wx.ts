import { envStr } from './envParse.ts';

// 微信公众号 API 基础地址（凭证已迁移到 wxAccounts 集合按用户存储，base URL 固定常量，不再读 env）
export const WX_BASE_URL = 'https://api.weixin.qq.com';

// 素材类型：图片（image）、语音（voice）、视频（video）、缩略图（thumb）
export const MEDIA_TYPES = ['image', 'voice', 'video', 'thumb'] as const;

/**
 * src 是否为微信永久素材 media_id（纯字母数字 + 下划线 + 连字符）。
 * 严格匹配防绕过：javascript: 等带冒号/空格的注入串不视为 media_id。
 */
export const isMediaIdSrc = (src: string): boolean => /^[A-Za-z0-9_-]+$/.test(src);

// 图文正文图片（media/uploadimg）限制：仅支持 jpg/png，且必须小于 1MB
export const WX_CONTENT_IMAGE_MAX_BYTES = 1024 * 1024;
export const WX_CONTENT_IMAGE_EXTENSIONS: readonly string[] = ['.jpg', '.jpeg', '.png'];

// 素材扩展名 → MIME（media 字段需携带 content-type）
export const MIME_MAP: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.mp3': 'audio/mpeg',
    '.wma': 'audio/x-ms-wma',
    '.wav': 'audio/wav',
    '.amr': 'audio/amr',
    '.mp4': 'video/mp4',
};

/**
 * 微信公众号环境变量常量。
 *
 * 注：公众号凭证已迁移到 wxAccounts 集合按用户存储，以下 env 当前无消费方（签名校验 token 亦改由 DB 配置），
 * 此处先归一化声明，保持环境变量读取点集中。
 */
export class WxConstants {
    /** 公众号 AppID（WX_APPID） */
    public static readonly APPID: string = envStr('WX_APPID');
    /** 公众号 AppSecret（WX_AppSecret） */
    public static readonly APP_SECRET: string = envStr('WX_AppSecret');
    /** 消息加解密 EncodingAESKey（WX_EncodingAESKey） */
    public static readonly ENCODING_AES_KEY: string = envStr('WX_EncodingAESKey');
    /** 服务器签名校验 token（WX_TOKEN） */
    public static readonly TOKEN: string = envStr('WX_TOKEN');
    /** 公众号 API 基础地址（固定常量 WX_BASE_URL） */
    public static readonly BASE_URL: string = WX_BASE_URL;
}
