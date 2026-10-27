import { sessionRepository } from './session.repository.ts';
import type { SessionDocument } from './session.entity.ts';
import { uuidManageService } from '../../utils/service/UuidManageService.ts';
import { UuidConstants } from '../../utils/constant/UuidConstants.ts';
import type { UuidManage } from '../../type/index.d.ts';
import type { CreateSessionDto, UpdateSessionDto, SessionQueryDto } from './session.dto.ts';

class SessionService {
  /** 分页查询（管理视角，默认包含已过期） */
  async list(query: SessionQueryDto): Promise<UuidManage.Page<UuidManage.Record>> {
    const result = await sessionRepository.findMany({
      ...query,
      includeExpired: query.includeExpired ?? true,
    });
    return {
      ...result,
      list: result.list.map(doc => this.toRecord(doc)),
    };
  }

  /** 详情（含已过期） */
  async getById(id: string): Promise<UuidManage.Record | null> {
    const doc = await sessionRepository.findById(id);
    if (!doc) {
      return null;
    }
    return this.toRecord(doc);
  }

  /** 创建（服务端签发 uuid，自动计算 expireAt） */
  async create(dto: CreateSessionDto): Promise<{ created: UuidManage.Record } | { error: string }> {
    try {
      const id = await uuidManageService.issue(dto.userId, dto.name, dto.scene, dto.ttl ?? UuidConstants.DEFAULT_TTL);
      const record = await uuidManageService.status(id);
      if (!record) {
        return { error: 'Session 创建失败' };
      }
      return { created: record };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Session 创建失败' };
    }
  }

  /** 更新（仅 name / scene） */
  async update(id: string, dto: UpdateSessionDto): Promise<{ updated: UuidManage.Record } | { error: string }> {
    const updated = await sessionRepository.updateById(id, dto);
    if (!updated) {
      return { error: 'Session 不存在' };
    }
    return { updated: this.toRecord(updated) };
  }

  /** 删除（假删除，flag → 0） */
  async delete(id: string): Promise<{ error?: string }> {
    const ok = await sessionRepository.softDeleteById(id);
    if (!ok) {
      return { error: 'Session 不存在' };
    }
    return {};
  }

  /** 文档 → 对外 Record（Date → 毫秒时间戳） */
  private toRecord(doc: SessionDocument): UuidManage.Record {
    return {
      _id: doc._id.toString(),
      userId: doc.userId,
      uuid: doc.uuid,
      scene: doc.scene,
      // 兼容新增 name 前的历史数据
      name: doc.name ?? '',
      status: doc.status,
      ttl: doc.ttl,
      expireAt: doc.expireAt ? doc.expireAt.getTime() : null,
      issuedAt: doc.createdAt.getTime(),
      updatedAt: doc.updatedAt.getTime(),
    };
  }
}

export const sessionService = new SessionService();
