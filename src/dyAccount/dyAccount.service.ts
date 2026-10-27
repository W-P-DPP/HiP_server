import { dyAccountRepository } from './dyAccount.repository.ts';
import type { CreateDyAccountDto, UpdateDyAccountDto, DyAccountQueryDto } from './dyAccount.dto.ts';
import type { DyAccountDocument } from './dyAccount.entity.ts';
import type { DyAccount } from '../../type/index.d.ts';
import { DY_BASE_URL } from '../../utils/constant/dy.ts';

class DyAccountService {
  /** 分页查询抖音应用配置（恒按当前用户隔离） */
  async list(userId: string, query: DyAccountQueryDto): Promise<DyAccount.Page<DyAccountDocument>> {
    return dyAccountRepository.findMany({ ...query, userId });
  }

  /** 获取单个抖音应用配置 */
  async getById(userId: string, id: string): Promise<{ account: DyAccountDocument } | { error: string }> {
    const account = await dyAccountRepository.findById(id, userId);
    if (!account) {
      return { error: '抖音应用配置不存在' };
    }
    return { account };
  }

  /** 获取当前登录用户的抖音应用配置（用户与应用 1:1，不区分启用/停用） */
  async getMine(userId: string): Promise<{ account: DyAccountDocument } | { error: string }> {
    const account = await dyAccountRepository.findByUserId(userId);
    if (!account) {
      return { error: '抖音应用配置不存在' };
    }
    return { account };
  }

  /** 创建抖音应用配置（用户与应用 1:1，已配置则拒绝） */
  async create(userId: string, dto: CreateDyAccountDto): Promise<{ created: DyAccountDocument } | { error: string }> {
    try {
      const exists = await dyAccountRepository.existsByUserId(userId);
      if (exists) {
        return { error: '该用户已配置抖音应用' };
      }

      const created = await dyAccountRepository.create({ ...dto, userId });
      return { created };
    } catch (err) {
      // 并发创建时命中 {userId} 部分唯一索引 → 返回可重试冲突
      if (err instanceof Error && (err as { code?: number }).code === 11000) {
        return { error: '操作冲突，请重试' };
      }
      throw err;
    }
  }

  /** 更新抖音应用配置 */
  async update(userId: string, id: string, dto: UpdateDyAccountDto): Promise<{ updated: DyAccountDocument } | { error: string }> {
    const doc = await dyAccountRepository.findById(id, userId);
    if (!doc) {
      return { error: '抖音应用配置不存在' };
    }

    const updated = await dyAccountRepository.updateById(id, userId, dto);
    if (!updated) {
      return { error: '抖音应用配置不存在' };
    }

    return { updated };
  }

  /** 删除抖音应用配置（假删除） */
  async delete(userId: string, id: string): Promise<{ error?: string }> {
    const doc = await dyAccountRepository.findById(id, userId);
    if (!doc) {
      return { error: '抖音应用配置不存在' };
    }

    await dyAccountRepository.softDeleteById(id, userId);
    return {};
  }

  /**
   * 获取调用抖音 API 所需凭证（取该用户唯一启用应用；未配置时抛错，供后续 utils/dy/getToken 使用）。
   * 注意：此方法抛异常而非返回 { error }，因为 getToken 是低层工具、本就向上抛错。
   */
  async getCredential(userId: string): Promise<DyAccount.Credential> {
    const doc = await dyAccountRepository.findActiveByUserId(userId);
    if (!doc) {
      throw new Error('未配置抖音应用');
    }

    return { clientKey: doc.clientKey, clientSecret: doc.clientSecret, baseUrl: DY_BASE_URL };
  }

  /** 判断用户是否已配置启用状态的抖音应用（取数类接口发起抖音调用前的守卫） */
  async hasActiveAccount(userId: string): Promise<boolean> {
    const doc = await dyAccountRepository.findActiveByUserId(userId);
    return doc !== null;
  }
}

export const dyAccountService = new DyAccountService();
