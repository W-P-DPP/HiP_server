/** 并发受限的 FIFO 异步任务队列。 */

type AsyncTask = () => Promise<unknown>;

export class AsyncQueue {
    private readonly maxConcurrent: number;
    private readonly queue: AsyncTask[] = [];
    private active = 0;
    /** 队尾结算链：drain() 等待所有已入队任务结算（吞掉错误，不阻断后续任务） */
    private settleTail: Promise<void> = Promise.resolve();

    /** concurrency：并发上限；0 / 负数 / NaN 一律按 1 处理（单实例串行） */
    constructor(concurrency: number) {
        this.maxConcurrent = Math.max(1, Math.floor(concurrency) || 1);
    }

    /** 并发上限（经构造函数规整后的实际值） */
    get concurrency(): number {
        return this.maxConcurrent;
    }

    /** 当前排队（含执行中）任务数 */
    get size(): number {
        return this.queue.length + this.active;
    }

    /** 当前执行中任务数 */
    get activeCount(): number {
        return this.active;
    }

    /**
     * 入队。返回的 Promise 在对应任务完成时 resolve；
     * 任务抛错时该 Promise reject（不影响队列继续执行）。
     */
    enqueue(task: AsyncTask): Promise<void> {
        const result = new Promise<void>((resolve, reject) => {
            const run = async (): Promise<void> => {
                try {
                    await task();
                    resolve();
                } catch (err) {
                    reject(err);
                } finally {
                    this.active -= 1;
                    this.next();
                }
            };
            this.queue.push(run);
            this.next();
        });
        // 链在队尾之后；drain() 等待所有已入队任务结算，任务失败也不中断 drain
        this.settleTail = this.settleTail.then(
            () => result.then(() => undefined, () => undefined),
            () => result.then(() => undefined, () => undefined),
        );
        return result;
    }

    /**
     * 等待所有已入队任务执行完成（排队 + 执行中），用于优雅退出时排空。
     * 之后新入队的任务不计入本次等待。
     */
    drain(): Promise<void> {
        return this.settleTail;
    }

    /** 把队列中的任务启动到并发上限。单线程内同步执行，无竞态。 */
    private next(): void {
        while (this.active < this.maxConcurrent && this.queue.length > 0) {
            const run = this.queue.shift()!; // length > 0 已保证非空
            this.active += 1;
            void run(); // run 内部 try/catch/finally，其 Promise 永不 reject，不会产生 unhandled rejection
        }
    }
}
