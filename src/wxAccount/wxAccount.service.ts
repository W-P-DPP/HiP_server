import { wxAccountRepository } from './wxAccount.repository.ts';
import type { CreateWxAccountDto, UpdateWxAccountDto, WxAccountQueryDto } from './wxAccount.dto.ts';
import type { WxAccountDocument } from './wxAccount.entity.ts';
import type { WxAccount } from '../../type/index.d.ts';
import RedisService from '../../utils/Redis.ts';
import { CacheConstants } from '../../utils/constant/CacheConstants.ts';
import { WX_BASE_URL } from '../../utils/constant/wx.ts';

class WxAccountService {
  /** 分页查询公众号配置（恒按当前用户隔离） */
  async list(userId: string, query: WxAccountQueryDto): Promise<WxAccount.Page<WxAccountDocument>> {
    return wxAccountRepository.findMany({ ...query, userId });
  }

  /** 获取单个公众号配置 */
  async getById(userId: string, id: string): Promise<{ account: WxAccountDocument } | { error: string }> {
    const account = await wxAccountRepository.findById(id, userId);
    if (!account) {
      return { error: '公众号配置不存在' };
    }
    return { account };
  }

  /** 创建公众号配置（用户与公众号 1:1，已配置则拒绝） */
  async create(userId: string, dto: CreateWxAccountDto): Promise<{ created: WxAccountDocument } | { error: string }> {
    try {
      const exists = await wxAccountRepository.existsByUserId(userId);
      if (exists) {
        return { error: '该用户已配置公众号' };
      }

      const created = await wxAccountRepository.create({ ...dto, userId });
      return { created };
    } catch (err) {
      // 并发创建时命中 {userId} 部分唯一索引 → 返回可重试冲突
      if (err instanceof Error && (err as { code?: number }).code === 11000) {
        return { error: '操作冲突，请重试' };
      }
      throw err;
    }
  }

  /** 更新公众号配置（凭证变更时失效对应 access_token 缓存） */
  async update(userId: string, id: string, dto: UpdateWxAccountDto): Promise<{ updated: WxAccountDocument } | { error: string }> {
    const doc = await wxAccountRepository.findById(id, userId);
    if (!doc) {
      return { error: '公众号配置不存在' };
    }

    const updated = await wxAccountRepository.updateById(id, userId, dto);
    if (!updated) {
      return { error: '公众号配置不存在' };
    }

    // 凭证（appSecret/appId）变更后失效对应 access_token 缓存
    if (dto.appSecret || (dto.appId && dto.appId !== doc.appId)) {
      await this.invalidateTokenCache(userId);
    }

    return { updated };
  }

  /** 删除公众号配置（假删除） */
  async delete(userId: string, id: string): Promise<{ error?: string }> {
    const doc = await wxAccountRepository.findById(id, userId);
    if (!doc) {
      return { error: '公众号配置不存在' };
    }

    await wxAccountRepository.softDeleteById(id, userId);
    await this.invalidateTokenCache(userId);
    return {};
  }

  /**
   * 获取调用微信 API 所需凭证（取该用户唯一启用公众号；未配置时抛错，供 utils/wx/getToken 使用）。
   * 注意：此方法抛异常而非返回 { error }，因为 getToken 是低层工具、本就向上抛错。
   */
  async getCredential(userId: string): Promise<WxAccount.Credential> {
    const doc = await wxAccountRepository.findActiveByUserId(userId);
    if (!doc) {
      throw new Error('未配置公众号');
    }

    return { appId: doc.appId, appSecret: doc.appSecret, baseUrl: WX_BASE_URL };
  }

  /**
   * 获取公众号服务器配置 Token（微信签名校验用；未配置或缺少 token 时抛错，供 signature 回调使用）。
   * 与 getCredential 同思路：低层校验工具、本就向上抛错，故返回 string 而非 { error }。
   */
  async getSignatureToken(userId: string): Promise<string> {
    const doc = await wxAccountRepository.findActiveByUserId(userId);
    if (!doc?.token) {
      throw new Error('未配置公众号 token');
    }

    return doc.token;
  }

  /** 判断用户是否已配置启用状态的公众号（取数类接口发起微信调用前的守卫） */
  async hasActiveAccount(userId: string): Promise<boolean> {
    const doc = await wxAccountRepository.findActiveByUserId(userId);
    return doc !== null;
  }

  /** 失效该用户 access_token 缓存（appSecret/appId 变更时调用） */
  private async invalidateTokenCache(userId: string): Promise<void> {
    await RedisService.getInstance().del(`${CacheConstants.ACCESS_TOKEN_KEY}${userId}`);
  }
}

export const wxAccountService = new WxAccountService();
