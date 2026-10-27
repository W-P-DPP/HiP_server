import type { RedisClientType } from 'redis';
import {
  tryAcquireLeaderLease as acquireLeaderLease,
  type LeaderLease,
} from '../leaderLease.ts';

/** 全机唯一的 IndexTTS leader 租约键 */
export const INDEXTTS_LEADER_KEY = 'wxbot:indextts:leader';

/** 通用租约的别名，保持既有调用点的类型名不变 */
export type IndexttsLeaderLease = LeaderLease;

export interface AcquireLeaderLeaseOptions {
  /** 租约 TTL（ms），默认 60000 */
  ttlMs?: number;
  /** 注入 Redis client（测试用） */
  client?: RedisClientType;
  /** 覆盖租约键（测试用） */
  key?: string;
}

/**
 * IndexTTS leader 租约（通用实现的薄封装，见 utils/leaderLease.ts）。
 *
 * 为什么需要它：音色克隆只允许全机一个 GPU 常驻模型，而 Express 跑在 node:cluster 下
 * （生产 CLUSTER_WORKERS=10）。若每个 worker 各拉起一个 Python worker，10 份 IndexTTS2
 * 会把一张卡直接打爆。这里用 Redis 租约把「持有模型」的进程收敛到唯一一个。
 */
export async function tryAcquireLeaderLease(
  options: AcquireLeaderLeaseOptions = {},
): Promise<IndexttsLeaderLease | null> {
  return acquireLeaderLease({
    key: options.key ?? INDEXTTS_LEADER_KEY,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.client !== undefined ? { client: options.client } : {}),
  });
}
