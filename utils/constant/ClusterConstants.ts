// node:cluster 多进程 + Redis 全局信号量 + 任务恢复常量

// ---- Redis 全局信号量 ----
/** 信号量槽位 key 前缀（完整 key：`${前缀}${name}:slot:${i}`） */
export const SEMAPHORE_KEY_PREFIX = 'wxbot:semaphore:';
/** 槽位租约 TTL（ms）。持有者崩溃后到期自动还槽，长任务由续期定时器保活 */
export const SEMAPHORE_LEASE_TTL_MS = 10 * 60 * 1000;
/** 并发满时的轮询间隔（ms） */
export const SEMAPHORE_POLL_INTERVAL_MS = 1000;

// ---- 任务恢复（recoverStuckRunning） ----
/** per-generation 恢复锁 key 前缀（完整 key：`${前缀}${generation}`） */
export const RECOVERY_LOCK_PREFIX = 'wxbot:recovery:';
/** 恢复锁 TTL（秒）。key 兼作「本代已恢复」标记，30 天覆盖 worker 长时间后才重启的边缘场景 */
export const RECOVERY_LOCK_TTL = 30 * 24 * 60 * 60;
/** running 任务超过该时长才算卡死（timestamps 保证 updatedAt≈领取时间，阈值防误杀执行中的任务） */
export const RECOVERY_STALE_THRESHOLD_MS = 30 * 1000;
/**
 * 任务被中断后允许重新入队的最大领取次数。
 *
 * 中断恢复把孤儿 running 任务重排回 pending（而非直接判失败），但必须有闸：超过该次数
 * 仍被判为孤儿则标记 failed，否则一条每次都弄崩进程的任务会无限重试。
 */
export const TASK_MAX_ATTEMPTS = 3;

// ---- worker 生命周期 ----
/** 启动失败重试指数退避基数（ms） */
export const WORKER_RESTART_BASE_DELAY_MS = 1000;
/** 启动失败重试退避上限（ms） */
export const WORKER_RESTART_MAX_DELAY_MS = 30 * 1000;
/** 连续启动失败熔断阈值（防崩溃风暴） */
export const WORKER_MAX_STARTUP_FAILURES = 10;
/** master 等待全部 worker 排空退出的超时（ms） */
export const MASTER_SHUTDOWN_TIMEOUT_MS = 10 * 1000;
/** worker 排空超时（ms）。对齐 docker stop 默认 SIGTERM 后 10s 强杀 */
export const SHUTDOWN_TIMEOUT_MS = 8 * 1000;
