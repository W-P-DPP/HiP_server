import crypto from 'node:crypto';
import type { RedisClientType } from 'redis';
import RedisService from './Redis.ts';
import { getWorkerId } from './clusterConfig.ts';

/** 仅当租约仍归本 token 所有时才续期 */
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end`;

/** 仅当租约仍归本 token 所有时才释放（防止本租约过期、他人接管后误删） */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

/** 持有期间必须持续续期；TTL 到期未续期即视为宕机，自动还权 */
export interface LeaderLease {
  readonly token: string;
  /** 续期；返回 false 表示已失去租约（他人接管或已过期） */
  renew(): Promise<boolean>;
  /** 主动释放（幂等） */
  release(): Promise<void>;
}

/**
 * 通用 Redis leader 租约。
 *
 * 为什么需要它：本服务跑在 node:cluster 下（生产 CLUSTER_WORKERS=10），而 GPU 常驻模型、
 * 外部推理容器这类资源全机只允许一个调度者。用 Redis 租约把「跑调度循环」收敛到唯一进程，
 * 其余进程以非 leader 身份继续服务 HTTP。
 *
 * 与 utils/RedisSemaphore 的区别：那边是阻塞轮询的并发槽位，非阻塞获取拿不到就立即返回；
 * 且它的续期是 fire-and-forget（吞掉错误），无法表达「连续续期失败就下台」—— 而这正是
 * 网络分区后避免两个执行体并存的关键，故此处单独实现。
 */
class LeaderLeaseImpl implements LeaderLease {
  public readonly token: string;
  private released = false;

  constructor(
    private readonly client: RedisClientType,
    private readonly key: string,
    private readonly ttlSec: number,
  ) {
    this.token = `${getWorkerId()}:${process.pid}:${crypto.randomUUID()}`;
  }

  async renew(): Promise<boolean> {
    if (this.released) return false;
    try {
      const result = await this.client.eval(RENEW_SCRIPT, {
        keys: [this.key],
        arguments: [this.token, String(this.ttlSec)],
      });
      return Number(result) === 1;
    } catch {
      // Redis 抖动不应立即判定失权，由调用方按「连续失败次数」决定是否下台
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await this.client.eval(RELEASE_SCRIPT, { keys: [this.key], arguments: [this.token] });
    } catch {
      // 释放失败无妨：TTL 到期后槽位自动归还
    }
  }
}

export interface AcquireLeaderLeaseOptions {
  /** 租约键（各业务用不同 key 即可让多套调度器各自选举） */
  key: string;
  /** 租约 TTL（ms），默认 60000 */
  ttlMs?: number;
  /** 注入 Redis client（测试用） */
  client?: RedisClientType;
}

/**
 * 非阻塞地抢占 leader 租约。
 * 返回 null 表示当前已有他人持有 —— 调用方应继续以非 leader 身份服务（不启动 dispatcher）。
 */
export async function tryAcquireLeaderLease(
  options: AcquireLeaderLeaseOptions,
): Promise<LeaderLease | null> {
  const ttlMs = options.ttlMs ?? 60_000;
  const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
  const client = options.client ?? (RedisService.getInstance().getClient() as RedisClientType);

  const lease = new LeaderLeaseImpl(client, options.key, ttlSec);
  const ok = await client.set(options.key, lease.token, { NX: true, EX: ttlSec });
  return ok ? lease : null;
}
