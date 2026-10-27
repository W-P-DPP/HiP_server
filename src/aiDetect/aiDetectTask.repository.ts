import AiDetectTaskModel, { type AiDetectTaskDocument, type IAiDetectScene } from './aiDetectTask.entity.ts';
import type {
  CompleteAiDetectTaskData,
  CreateAiDetectTaskData,
  QueryAiDetectTaskData,
} from './aiDetect.dto.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';

class AiDetectTaskRepository {
  /** 创建场景切分任务（pending，进度归零） */
  async create(data: CreateAiDetectTaskData): Promise<AiDetectTaskDocument> {
    return AiDetectTaskModel.create({
      ...data,
      status: 'pending',
      progress: 0,
      stage: 'pending',
      message: '',
      workerId: '',
      attempts: 0,
      remoteUrl: data.remoteUrl ?? '',
      scenes: [],
      sceneCount: 0,
      durationMs: 0,
      frameRate: 0,
      pySceneDetectVersion: '',
      userId: data.userId ?? '',
    });
  }

  /** 按主键查找任务（仅未删除） */
  async findById(id: string): Promise<AiDetectTaskDocument | null> {
    return AiDetectTaskModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /**
   * 原子领取「最老的一条 pending 任务」并置为 running。
   *
   * 单条 findOneAndUpdate 保证同一任务在并发下只会被一个执行体拿到；配合 leader 租约
   * （全机只有一个 dispatcher）即构成完整的互斥。返回 null 表示当前没有待处理任务。
   *
   * 注意 `flag` 必须放在 filter 里 —— 它是 select:false 字段，放 projection 不生效。
   */
  async claimNextPending(workerId: string): Promise<AiDetectTaskDocument | null> {
    return AiDetectTaskModel.findOneAndUpdate(
      { status: 'pending', flag: 1 },
      { $set: { status: 'running', startedAt: new Date(), workerId }, $inc: { attempts: 1 } },
      { returnDocument: 'after', sort: { createdAt: 1 }, runValidators: true },
    ).exec();
  }

  /**
   * 更新执行进度。限定 status=running，避免任务已进入终态后仍被迟到的进度回调覆盖。
   * 返回 null 表示任务已被终结（或不存在）。
   */
  async updateProgress(
    id: string,
    data: { progress: number; stage: string; message: string },
  ): Promise<AiDetectTaskDocument | null> {
    return AiDetectTaskModel.findOneAndUpdate(
      { _id: id, status: 'running', flag: 1 },
      { $set: data },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 标记成功（写入场景结果，进度置满） */
  async markSuccess(
    id: string,
    data: CompleteAiDetectTaskData,
  ): Promise<AiDetectTaskDocument | null> {
    return AiDetectTaskModel.findOneAndUpdate(
      { _id: id, flag: 1 },
      { $set: { status: 'success', progress: 1, stage: 'done', message: '', ...data } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 场景合并的写回：整体替换 scenes 与 sceneCount。
   *
   * 只动这两个字段 —— status / progress / stage / workerId / attempts 都是执行态，与场景划分无关。
   * 用 $set 整体替换数组而非 $push：合并结果本身就是一份完整划分，且长度必然变短。
   * filter 里带上 userId 与 flag:1：归属校验不能只依赖调用方「先读一次」的结果。
   */
  async updateScenes(
    id: string,
    userId: string,
    scenes: IAiDetectScene[],
  ): Promise<AiDetectTaskDocument | null> {
    return AiDetectTaskModel.findOneAndUpdate(
      { _id: id, userId, flag: 1 },
      { $set: { scenes, sceneCount: scenes.length } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 标记失败（写入失败原因） */
  async markFailed(
    id: string,
    message: string,
    finishedAt: Date,
  ): Promise<AiDetectTaskDocument | null> {
    return AiDetectTaskModel.findOneAndUpdate(
      { _id: id, flag: 1 },
      { $set: { status: 'failed', stage: 'failed', message, finishedAt } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 取消一条排队中的任务。
   *
   * 与 claimNextPending 同以 status='pending' 为条件，故二者对同一条记录互斥：取消成功后
   * dispatcher 不再能领取它。返回 null 表示任务当前不是 pending（已被领取或已是终态）。
   */
  async cancelPending(id: string): Promise<AiDetectTaskDocument | null> {
    return AiDetectTaskModel.findOneAndUpdate(
      { _id: id, status: 'pending', flag: 1 },
      { $set: { status: 'cancelled', stage: 'cancelled', message: '任务已取消', finishedAt: new Date() } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 中断恢复的公共实现：符合 orphanFilter 的孤儿 running 任务重新入队。
   *
   * 重入队而非直接判失败：中断往往发生在进程重启/发布期间，直接判失败会让已跑了大半的检测白费。
   */
  private async requeueOrphan(
    orphanFilter: Record<string, unknown>,
    maxAttempts: number,
    message: string,
  ): Promise<number> {
    const result = await AiDetectTaskModel.updateMany(
      { ...orphanFilter, attempts: { $lt: maxAttempts } },
      { $set: { status: 'pending', stage: 'pending', message, workerId: '' } },
    ).exec();
    return result.modifiedCount;
  }

  /** 中断恢复的公共实现：符合 orphanFilter 且已达重试上限的孤儿直接标记失败 */
  private async failExhaustedOrphan(
    orphanFilter: Record<string, unknown>,
    maxAttempts: number,
    message: string,
  ): Promise<number> {
    const result = await AiDetectTaskModel.updateMany(
      { ...orphanFilter, attempts: { $gte: maxAttempts } },
      { $set: { status: 'failed', stage: 'failed', message, finishedAt: new Date() } },
    ).exec();
    return result.modifiedCount;
  }

  /**
   * 启动 / 接手租约时的孤儿清扫：把**任何 workerId** 的 running 任务重新入队。
   *
   * 依据：租约保证全机只有一个调度器，且调度器受 concurrency 约束（调用方已保证此刻没有在途任务）。
   * 因此此刻 Mongo 里任何 status=running 的行都必然是上一代进程遗留的孤儿。不能只用 workerId 匹配
   * —— cluster 重启后 worker id 会重新从 1 分配，旧进程写的 id 未必等于新 leader 的 id。
   */
  async requeueOrphanRunning(maxAttempts: number, message: string): Promise<number> {
    return this.requeueOrphan({ status: 'running', flag: 1 }, maxAttempts, message);
  }

  /** 与 requeueOrphanRunning 互补：孤儿中 attempts 已达上限的直接标记失败 */
  async failExhaustedOrphanRunning(maxAttempts: number, message: string): Promise<number> {
    return this.failExhaustedOrphan({ status: 'running', flag: 1 }, maxAttempts, message);
  }

  /**
   * 服务重启恢复：把「status=running 且 updatedAt 早于 staleBefore」的遗留任务重新入队。
   * 阈值必须大于一次完整检测的耗时，否则会把正在跑的长任务误判为孤儿。
   */
  async requeueStuckRunning(staleBefore: Date, maxAttempts: number, message: string): Promise<number> {
    return this.requeueOrphan(
      { status: 'running', updatedAt: { $lt: staleBefore }, flag: 1 },
      maxAttempts,
      message,
    );
  }

  /** 与 requeueStuckRunning 互补：陈旧且 attempts 已达上限的孤儿直接失败 */
  async failExhaustedStuckRunning(
    staleBefore: Date,
    maxAttempts: number,
    message: string,
  ): Promise<number> {
    return this.failExhaustedOrphan(
      { status: 'running', updatedAt: { $lt: staleBefore }, flag: 1 },
      maxAttempts,
      message,
    );
  }

  /** 待处理任务数（/engine/status 的队列深度） */
  async countPending(): Promise<number> {
    return AiDetectTaskModel.countDocuments({ status: 'pending', flag: 1 });
  }

  /** 队列中 createdAt 早于给定时刻的 pending 任务数（+1 即排队位次） */
  async countPendingBefore(createdAt: Date): Promise<number> {
    return AiDetectTaskModel.countDocuments({
      status: 'pending',
      flag: 1,
      createdAt: { $lt: createdAt },
    });
  }

  /** 正在执行的任务数（上限为 AI_DETECT_CONCURRENCY） */
  async countRunning(): Promise<number> {
    return AiDetectTaskModel.countDocuments({ status: 'running', flag: 1 });
  }

  /** 分页查询某用户的场景切分任务：按创建时间倒序，仅未删除 */
  async findPageByUser(
    query: QueryAiDetectTaskData,
  ): Promise<PaginatedResponse<AiDetectTaskDocument>> {
    const { page, limit } = query;
    const pageNum = Number.isFinite(page) ? Math.max(1, Math.floor(page as number)) : 1;
    const limitNum = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit as number))) : 20;

    const filter: Record<string, unknown> = { flag: 1 };
    if (query.userId) filter.userId = query.userId;
    if (query.status) filter.status = query.status;

    const [list, total] = await Promise.all([
      AiDetectTaskModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      AiDetectTaskModel.countDocuments(filter),
    ]);

    return { list: list as unknown as AiDetectTaskDocument[], total, page: pageNum, limit: limitNum };
  }
}

export const aiDetectTaskRepository = new AiDetectTaskRepository();
