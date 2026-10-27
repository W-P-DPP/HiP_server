import AxiosService from '../Axios.ts';
import RedisService from '../Redis.ts';
import { Logger } from '../Logger.ts';
import type { IWxTokenResponse } from './wx.d.ts'
import { wxAccountService } from '../../src/wxAccount/wxAccount.service.ts';
import { CacheConstants } from '../constant/CacheConstants.ts';
import { WX_BASE_URL } from '../constant/wx.ts';

const instance = AxiosService.getInstance();
const redis = RedisService.getInstance();
const logger = Logger.getInstance()


/**
 * 获取微信公众号 access_token（按用户从 DB 配置读取凭证，env 不兜底）。
 * 用户与公众号一一对应：取该用户唯一启用公众号的凭证。
 * @param userId 归属用户 id（wxAccounts 配置的 userId）
 */
export const getToken = async (userId: string): Promise<string> => {
    // 缓存 key 按 userId 隔离，杜绝多用户串号
    const cacheKey = `${CacheConstants.ACCESS_TOKEN_KEY}${userId}`
    const cached = await redis.get(cacheKey)
    if (cached) return cached
    logger.info('云端获取微信公众号token 开始')
    const cred = await wxAccountService.getCredential(userId)
    const url = WX_BASE_URL + '/cgi-bin/token'
    const res = await instance.get<IWxTokenResponse>(url, {
        params: {
            appid: cred.appId, secret: cred.appSecret,
            grant_type: "client_credential"
        }
    })
    if (!res.access_token) {
        throw new Error(`微信 token 获取失败：${JSON.stringify(res)}`)
    }
    await redis.set(cacheKey, res.access_token, res.expires_in - 120)
    return res.access_token
}