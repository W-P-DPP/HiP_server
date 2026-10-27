import { skillRepository } from './skill.repository.ts';
import { subscriptionService } from '../subscription/subscription.service.ts';
import type { CreateSkillDto, UpdateSkillDto, SkillQueryDto } from './skill.dto.ts';
import type { SkillDocument } from './skill.entity.ts';

class SkillService {
  /** 获取 Skill 分页列表 */
  async list(query: SkillQueryDto) {
    return skillRepository.findMany(query);
  }

  /** 获取单个 Skill */
  async getByKey(key: string): Promise<SkillDocument | null> {
    return skillRepository.findByKey(key);
  }

  /** 创建 Skill（同 key 已假删除时恢复，避免唯一索引冲突） */
  async create(dto: CreateSkillDto): Promise<{ created: SkillDocument } | { error: string }> {
    const exists = await skillRepository.existsByKey(dto.key);
    if (exists) {
      return { error: 'Skill key 已存在' };
    }

    // 假删除恢复：同 key 的 flag:0 记录存在则恢复，否则新建
    const restored = await skillRepository.restoreByKey(dto.key, dto);
    if (restored) {
      return { created: restored };
    }

    const created = await skillRepository.create(dto);
    return { created };
  }

  /** 更新 Skill */
  async update(key: string, dto: UpdateSkillDto): Promise<{ updated: SkillDocument } | { error: string }> {
    const updated = await skillRepository.updateByKey(key, dto);
    if (!updated) {
      return { error: 'Skill 不存在' };
    }
    return { updated };
  }

  /** 删除 Skill（假删除，级联取消所有活跃订阅） */
  async delete(key: string): Promise<{ error?: string }> {
    const deleted = await skillRepository.softDeleteByKey(key);
    if (!deleted) {
      return { error: 'Skill 不存在' };
    }
    // 级联取消该 Skill 的所有活跃订阅
    await subscriptionService.cancelAllForSkill(key);
    return {};
  }
}

export const skillService = new SkillService();
