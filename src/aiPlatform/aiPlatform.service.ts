import { aiPlatformRepository } from './aiPlatform.repository.ts';
import type { CreateAIPlatformDto, UpdateAIPlatformDto, AIPlatformQueryDto } from './aiPlatform.dto.ts';
import type { AIPlatformAccountDocument } from './aiPlatform.entity.ts';
import { isAIProvider, listProviderPresets, resolveBaseUrl } from '../../utils/AIPlatform/provider.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { AI_ACCOUNT_NAME_UNIQUE_INDEX } from '../../utils/constant/AIPlatform.ts';
import type { AIPlatform } from '../../type/index.d.ts';

/** 是否为「违反指定唯一索引」的重复键错误（driver 把索引名写在 message 里） */
function isDuplicateKeyOnIndex(err: unknown, indexName: string): boolean {
  const code = (err as { code?: number } | null)?.code;
  return err instanceof Error && code === 11000 && err.message.includes(`index: ${indexName}`);
}

class AIPlatformService {
  /** 平台预设目录（可选平台 + 默认 baseUrl + 预设模型） */
  async listProviders(): Promise<AIPlatform.ProviderPreset[]> {
    return listProviderPresets();
  }

  /** 分页查询平台配置（恒按当前用户隔离） */
  async list(userId: string, query: AIPlatformQueryDto): Promise<AIPlatform.Page<AIPlatformAccountDocument>> {
    return aiPlatformRepository.findMany({ ...query, userId });
  }

  /** 获取单个平台配置 */
  async getById(userId: string, id: string): Promise<{ account: AIPlatformAccountDocument } | { error: string }> {
    const account = await aiPlatformRepository.findById(id, userId);
    if (!account) {
      return { error: 'AI 平台配置不存在' };
    }
    return { account };
  }

  /** 创建平台配置（同一用户下配置名称唯一，同一平台允许多条） */
  async create(userId: string, dto: CreateAIPlatformDto): Promise<{ created: AIPlatformAccountDocument } | { error: string }> {
    if (!isAIProvider(dto.provider)) {
      return { error: '不支持的 AI 平台' };
    }

    const name = dto.name.trim();

    try {
      const exists = await aiPlatformRepository.existsByUserAndName(userId, name);
      if (exists) {
        return { error: '该配置名称已存在' };
      }

      const created = await aiPlatformRepository.create({ ...dto, name, userId });
      return { created };
    } catch (err) {
      // 并发创建时命中 {userId, name} 部分唯一索引；其他重复键（如残留的旧索引）不在此断言
      if (isDuplicateKeyOnIndex(err, AI_ACCOUNT_NAME_UNIQUE_INDEX)) {
        return { error: '该配置名称已存在' };
      }
      throw err;
    }
  }

  /** 更新平台配置（错误分支带 code：不存在 404 / 不支持的平台 400 / 名称为空 400 / 名称重复 409） */
  async update(
    userId: string,
    id: string,
    dto: UpdateAIPlatformDto,
  ): Promise<{ updated: AIPlatformAccountDocument } | { error: string; code: number }> {
    const doc = await aiPlatformRepository.findById(id, userId);
    if (!doc) {
      return { error: 'AI 平台配置不存在', code: HttpStatus.NOT_FOUND };
    }

    if (dto.provider !== undefined && !isAIProvider(dto.provider)) {
      return { error: '不支持的 AI 平台', code: HttpStatus.BAD_REQUEST };
    }

    const name = dto.name?.trim();
    if (dto.name !== undefined && !name) {
      return { error: '配置名称不能为空', code: HttpStatus.BAD_REQUEST };
    }
    if (name && name !== doc.name) {
      const conflict = await aiPlatformRepository.existsByUserAndName(userId, name);
      if (conflict) {
        return { error: '该配置名称已存在', code: HttpStatus.CONFLICT };
      }
    }

    const updated = await aiPlatformRepository.updateById(id, userId, { ...dto, ...(name ? { name } : {}) });
    if (!updated) {
      return { error: 'AI 平台配置不存在', code: HttpStatus.NOT_FOUND };
    }

    return { updated };
  }

  /** 删除平台配置（假删除） */
  async delete(userId: string, id: string): Promise<{ error?: string }> {
    const doc = await aiPlatformRepository.findById(id, userId);
    if (!doc) {
      return { error: 'AI 平台配置不存在' };
    }

    await aiPlatformRepository.softDeleteById(id, userId);
    return {};
  }

  /**
   * 解析调用平台所需凭证（供对话模块消费）。
   * 返回判别联合而非抛错：调用方（chat SSE）需要把失败翻成普通 ResultVO 信封。
   */
  async resolveCredential(
    userId: string,
    accountId: string,
  ): Promise<{ credential: AIPlatform.Credential } | { error: string; code: number }> {
    const account = await aiPlatformRepository.findById(accountId, userId);
    if (!account) {
      return { error: 'AI 平台配置不存在', code: 404 };
    }
    if (account.status !== 'active') {
      return { error: 'AI 平台配置已停用', code: 409 };
    }

    return {
      credential: {
        provider: account.provider,
        apiKey: account.apiKey,
        baseUrl: resolveBaseUrl(account.provider, account.baseUrl),
      },
    };
  }
}

export const aiPlatformService = new AIPlatformService();
