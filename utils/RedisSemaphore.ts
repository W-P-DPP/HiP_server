import crypto from 'node:crypto';
import type { RedisClientType } from 'redis';
import RedisService from './Redis.ts';
import { SEMAPHORE_KEY_PREFIX, SEMAPHORE_LEASE_TTL_MS, SEMAPHORE_POLL_INTERVAL_MS } from './constant/ClusterConstants.ts';

/** 信号量租约：持有槽位期间可释放（幂等） */
export interface SemaphoreLease {
    readonly token: string;
    readonly slotIndex: number;
    /** 释放槽位（幂等）。仅当槽位仍归本 token 所有时才删除 */
    release(): Promise<void>;
}

/** 仅当槽位仍归本 token 所有时才删除：防止本租约过期、槽位被他人占用后误删他人的租约 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RedisSemaphoreOptions {
    /** 槽位租约 TTL（ms），默认 10 分钟；长任务由续期定时器保活，崩溃后到期自动还槽 */
    leaseTtlMs?: number;
    /** 并发满时的轮询间隔（ms），默认 1000 */
    pollIntervalMs?: number;
    /** 注入 Redis client（测试用）；默认取 RedisService 单例 */
    client?: RedisClientType;
}

/**
 * Redis 全局信号量（固定槽位 + `SET NX EX` 租约）。
 * - 并发上限为 concurrency，跨进程共享，用于把 ffmpeg 等重任务全局限流。
 * - 持有者崩溃后租约到期自动还槽，零泄漏；长任务由续期定时器保活。
 */
export class RedisSemaphore {
    private readonly client: RedisClientType;
    private readonly name: string;
    private readonly concurrency: number;
    private readonly leaseTtlMs: number;
    private readonly pollIntervalMs: number;

    constructor(name: string, concurrency: number, options: RedisSemaphoreOptions = {}) {
        this.client = options.client ?? RedisService.getInstance().getClient();
        this.name = name;
        this.concurrency = Math.max(1, Math.floor(concurrency) || 1);
        this.leaseTtlMs = options.leaseTtlMs ?? SEMAPHORE_LEASE_TTL_MS;
        this.pollIntervalMs = options.pollIntervalMs ?? SEMAPHORE_POLL_INTERVAL_MS;
    }

    private slotKey(i: number): string {
        return `${SEMAPHORE_KEY_PREFIX}${this.name}:slot:${i}`;
    }

    /**
     * 获取一个全局槽位；并发满时轮询等待。
     * Redis 命令报错直接上抛（不无限重试），由调用方负责释放/失败处理。
     */
    async acquire(): Promise<SemaphoreLease> {
        const token = crypto.randomUUID();
        const ttlSec = Math.max(1, Math.floor(this.leaseTtlMs / 1000));
        for (;;) {
            for (let i = 1; i <= this.concurrency; i++) {
                const key = this.slotKey(i);
                const ok = await this.client.set(key, token, { NX: true, EX: ttlSec });
                if (ok) {
                    // 长任务期间周期性续期，防 TTL 误释放；进程崩溃后定时器停止，EX 到期自动还槽
                    const timer = setInterval(() => {
                        void this.client.expire(key, ttlSec).catch(() => {});
                    }, this.leaseTtlMs / 2);
                    timer.unref();
                    let released = false;
                    return {
                        token,
                        slotIndex: i,
                        release: async () => {
                            if (released) return;
                            released = true;
                            clearInterval(timer);
                            await this.client.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
                        },
                    };
                }
            }
            await sleep(this.pollIntervalMs);
        }
    }

    /** 当前全局已占用槽位数（供队列状态跨进程聚合） */
    async getLiveCount(): Promise<number> {
        let n = 0;
        for (let i = 1; i <= this.concurrency; i++) {
            const exists = await this.client.exists(this.slotKey(i));
            if (exists === 1) n += 1;
        }
        return n;
    }

    /** 全局并发上限 */
    getConcurrency(): number {
        return this.concurrency;
    }
}
