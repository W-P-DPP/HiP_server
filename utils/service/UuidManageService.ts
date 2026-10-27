import { uuid } from '../uuid.ts';
import { sessionRepository } from '../../src/session/session.repository.ts';
import type { SessionDocument } from '../../src/session/session.entity.ts';
import { UuidConstants } from '../constant/UuidConstants.ts';
import type { UuidManage } from '../../type/index.d.ts';

class UuidManageService {
  /**
   * 签发：生成 32 位无连字符 UUID 并登记为 active，返回 uuid
   * @param userId 关联用户
   * @param name 会话名称
   * @param scene 业务场景（可选）
   * @param ttl 有效期（秒），默认 1 天；传 '*' 表示永不过期
   */
  async issue(
    userId: string,
    name: string,
    scene?: string,
    ttl: UuidManage.Ttl = UuidConstants.DEFAULT_TTL,
  ): Promise<string> {
    UuidManageService.validateUserId(userId);
    // UuidManageService.validateScene(scene);

    const id = uuid(true);
    const now = new Date();
    const resolvedName = name.trim()

    if (ttl === UuidConstants.NEVER_EXPIRE) {
      // 永不过期
      await sessionRepository.create({
        userId,
        uuid: id,
        scene: scene?scene.trim():"",
        name: resolvedName,
        status: 'active',
        ttl: null,
        expireAt: null,
      });
    } else {
      if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl <= 0) {
        throw new Error('ttl 必须为正整数（秒）或 *（永不过期）');
      }
      await sessionRepository.create({
        userId,
        uuid: id,
        scene: scene?scene.trim():"",
        name: resolvedName,
        status: 'active',
        ttl,
        expireAt: new Date(now.getTime() + ttl * 1000),
      });
    }

    return id;
  }

  /** 原子一次性消费：仅 active 且未过期成功，标记 used（并发安全，防重复消费） */
  async consume(userId: string, id: string): Promise<UuidManage.MutationResult> {
    return this.mutate(userId, id, 'used');
  }

  /** 吊销：仅 active 且未过期成功，标记 revoked */
  async revoke(userId: string, id: string): Promise<UuidManage.MutationResult> {
    return this.mutate(userId, id, 'revoked');
  }

  /** 查询登记记录；不存在或已过期返回 null */
  async status( id: string): Promise<UuidManage.Record | null> {
    UuidManageService.validateUuid(id);

    const doc = await sessionRepository.findByUuid( id);
    if (!doc || UuidManageService.isExpired(doc)) {
      return null;
    }
    return this.toRecord(doc);
  }

  /** 分页查询用户的 Session（仅未过期） */
  async listByUser(
    userId: string,
    query: Partial<UuidManage.Query> = {},
  ): Promise<UuidManage.Page<UuidManage.Record>> {
    UuidManageService.validateUserId(userId);

    const result = await sessionRepository.findMany({ ...query, userId });
    return {
      ...result,
      list: result.list.map(doc => this.toRecord(doc)),
    };
  }

  /** consume/revoke 共用：状态迁移 + 失败原因区分 */
  private async mutate(userId: string, id: string, target: UuidManage.Status): Promise<UuidManage.MutationResult> {
    UuidManageService.validateUserId(userId);
    UuidManageService.validateUuid(id);

    const updated = await sessionRepository.transition(userId, id, target);
    if (updated) {
      return { ok: true, record: this.toRecord(updated) };
    }

    const doc = await sessionRepository.findByUuid( id);
    if (!doc) {
      return { ok: false, code: 'not_found' };
    }
    if (UuidManageService.isExpired(doc)) {
      return { ok: false, code: 'expired' };
    }
    return { ok: false, code: 'not_active' };
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

  /** 是否已过期（expireAt 为 null 表示永不过期） */
  private static isExpired(doc: SessionDocument): boolean {
    return doc.expireAt !== null && doc.expireAt.getTime() <= Date.now();
  }

  private static validateUserId(userId: string): void {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('userId 不能为空');
    }
  }

  private static validateUuid(id: string): void {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('uuid 不能为空');
    }
  }

  private static validateScene(scene: string): void {
    if (typeof scene !== 'string' || scene.trim().length === 0) {
      throw new Error('scene 不能为空');
    }
  }
}

export const uuidManageService = new UuidManageService();
