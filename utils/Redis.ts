import { createClient, type RedisClientType } from 'redis';
import { Logger } from './index.ts';

/** 启动阶段首次连接的最长等待时间；超时即判为启动失败，避免 worker 卡死无法被 master/健康检查发现 */
const CONNECT_TIMEOUT_MS = 10_000;

class RedisService {
    private static instance: RedisService;
    private client: RedisClientType;
    private isConnected = false;
    /** 进行中的连接 Promise：并发调用 connect() 会触发 node-redis 的 "Socket already opened" */
    private connecting: Promise<void> | null = null;
    private logger = Logger.getInstance();

    private constructor() {
        this.client = createClient({
            url: this.buildRedisUrl(),
            socket: {
                reconnectStrategy: retries => {
                    // 返回数字代表「等待 N ms 后重连」。这里绝不能返回 Error：
                    // node-redis 一旦从 reconnectStrategy 收到 Error 就把 socket 永久标记为
                    // isOpen=false，此后所有命令都直接以 ClientClosedError「The client is closed」
                    // 拒绝——这就是生产环境登录偶发 500 的根因。改为无限退避重连，让连接自愈。
                    return Math.min(retries * 100, 3000);
                }
            }
        });

        this.client.on('connect', () => {
            this.logger.info('[Redis] connecting...');
            this.logger.info('[Redis] '+`redis://${process.env.REDIS_HOST}:${parseInt(process.env.REDIS_PORT)}`);
        });

        this.client.on('ready', () => {
            this.isConnected = true;
            this.logger.info('[Redis] ready');
        });

        this.client.on('error', err => {
            this.isConnected = false;
            this.logger.error(`[Redis] error: ${err}`);
        });

        this.client.on('end', () => {
            this.isConnected = false;
            this.logger.warn('[Redis] connection closed');
        });
    }

    /** 拼接 Redis 连接 URL（密码自动做 URL 编码） */
    private buildRedisUrl(): string {
        if (process.env.REDIS_URL) return process.env.REDIS_URL;
        const host = process.env.REDIS_HOST;
        const port = parseInt(process.env.REDIS_PORT || '6379');
        const password = process.env.REDIS_PASSWORD
            ? `:${encodeURIComponent(process.env.REDIS_PASSWORD)}@`
            : '';
        return `redis://${password}${host}:${port}`;
    }

    /** 获取单例 */
    public static getInstance(): RedisService {
        if (!RedisService.instance) {
            RedisService.instance = new RedisService();
        }
        return RedisService.instance;
    }

    /**
     * 确保连接可用：client 处于打开状态（含正在自动重连）时直接返回，命令会进入离线队列等待；
     * 仅当 client 已被关闭时才重新发起连接，并复用同一个连接 Promise 防止重复 connect。
     */
    private async ensureConnected(): Promise<void> {
        if (this.client.isOpen) return;
        if (!this.connecting) {
            const connecting = (async () => { await this.client.connect(); })();
            // 连接失败时释放占位，让下一次调用可以重试；同时吞掉无人 await 的 rejection
            connecting.catch(() => {}).finally(() => {
                if (this.connecting === connecting) this.connecting = null;
            });
            this.connecting = connecting;
        }
        await this.connecting;
    }

    /** 连接 Redis（启动阶段调用；超时视为启动失败） */
    public async connect(): Promise<void> {
        await this.withTimeout(this.ensureConnected(), CONNECT_TIMEOUT_MS);
    }

    private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Redis 连接超时（${ms}ms）`)), ms);
            timer.unref();
            promise.then(
                value => { clearTimeout(timer); resolve(value); },
                err => { clearTimeout(timer); reject(err); },
            );
        });
    }

    /** 获取原始 client（高级用法） */
    public getClient(): RedisClientType {
        return this.client;
    }

    /** 设置字符串 */
    public async set(
        key: string,
        value: string,
        ttl?: number
    ): Promise<void> {
        await this.ensureConnected();
        if (ttl) {
            await this.client.setEx(key, ttl, value);
        } else {
            await this.client.set(key, value);
        }
    }

    /** 获取字符串 */
    public async get(key: string): Promise<string | null> {
        await this.ensureConnected();
        return this.client.get(key);
    }

    /** 设置 JSON */
    public async setJSON<T>(
        key: string,
        value: T,
        ttl?: number
    ): Promise<void> {
        const data = JSON.stringify(value);
        await this.set(key, data, ttl);
    }

    /** 获取 JSON */
    public async getJSON<T>(key: string): Promise<T | null> {
        const data = await this.get(key);
        return data ? (JSON.parse(data) as T) : null;
    }

    /** 删除 key */
    public async del(key: string): Promise<number> {
        await this.ensureConnected();
        return this.client.del(key);
    }

    /** 判断 key 是否存在 */
    public async exists(key: string): Promise<boolean> {
        await this.ensureConnected();
        return (await this.client.exists(key)) === 1;
    }

    /** 设置过期时间 */
    public async expire(key: string, ttl: number): Promise<boolean> {
        await this.ensureConnected();
        return (await this.client.expire(key, ttl)) === 1;
    }

    /** 原子自增 */
    public async incr(key: string): Promise<number> {
        await this.ensureConnected();
        return this.client.incr(key);
    }

    /** 原子自减 */
    public async decr(key: string): Promise<number> {
        await this.ensureConnected();
        return this.client.decr(key);
    }

    /** 关闭连接 */
    public async quit(): Promise<void> {
        if (this.client.isOpen) {
            await this.client.quit();
        }
        this.isConnected = false;
    }
}

export default RedisService;
