import AiDetectAsrTaskModel, { type AiDetectAsrTaskDocument } from './aiDetectAsrTask.entity.ts';
import type {
  CompleteAsrTaskData,
  CreateAsrTaskData,
  QueryAiDetectAsrTaskData,
} from './aiDetect.dto.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';

/**
 * 场景转写任务的仓储。
 *
 * 与 aiDetectTask.repository.ts（场景切分）/ aiDetectFrameTask.repository.ts（抽帧）方法一一对应，
 * 但落在**自己的集合**上 —— 三条队列因此天然隔离：领取、并发额度、排队位次、中断恢复都各算各的。
 * 方法集刻意与另两个仓储保持同形（字幕 / 数字人 / VLM 各自的仓储同样各写一遍这套方法），便于对照排查。
 */
class AiDetectAsrTaskRepository {
  /** 创建转写任务（pending，进度归零） */
  async createAsrTask(data: CreateAsrTaskData): Promise<AiDetectAsrTaskDocument> {
    return AiDetectAsrTaskModel.create({
      ...data,
      status: 'pending',
      progress: 0,
      stage: 'pending',
      message: '',
      workerId: '',
      attempts: 0,
      chunks: [],
      segments: [],
      sceneSegments: [],
      segmentCount: 0,
      provider: '',
      userId: data.userId ?? '',
    });
  }

  /** 按主键查找任务（仅未删除） */
  async findById(id: string): Promise<AiDetectAsrTaskDocument | null> {
    return AiDetectAsrTaskModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /**
   * 原子领取「最老的一条 pending 任务」并置为 running。
   *
   * 单条 findOneAndUpdate 保证同一任务在并发下只会被一个执行体拿到；配合 leader 租约
   * （全机只有一个 dispatcher）即构成完整的互斥。返回 null 表示当前没有待处理任务。
   *
   * 注意 `flag` 必须放在 filter 里 —— 它是 select:false 字段，放 projection 不生效。
   */
  async claimNextPending(workerId: string): Promise<AiDetectAsrTaskDocument | null> {
    return AiDetectAsrTaskModel.findOneAndUpdate(
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
  ): Promise<AiDetectAsrTaskDocument | null> {
    return AiDetectAsrTaskModel.findOneAndUpdate(
      { _id: id, status: 'running', flag: 1 },
      { $set: data },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 记录已完成（或正在完成）的音频块。
   *
   * 与进度上报分开：块记录是**排障与复用凭据**（wav fileId、子任务 id），必须在每个块结束后
   * 立刻落库，不能等任务成功 —— 否则中途失败就再也说不清失败在哪一块。
   */
  async pushChunk(
    id: string,
    chunk: Record<string, unknown>,
  ): Promise<AiDetectAsrTaskDocument | null> {
    return AiDetectAsrTaskModel.findOneAndUpdate(
      { _id: id, status: 'running', flag: 1 },
      { $push: { chunks: chunk } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 标记成功（写入文本段与按场景归组的结果，进度置满） */
  async markSuccess(
    id: string,
    data: CompleteAsrTaskData,
  ): Promise<AiDetectAsrTaskDocument | null> {
    return AiDetectAsrTaskModel.findOneAndUpdate(
      { _id: id, flag: 1 },
      { $set: { status: 'success', progress: 1, stage: 'done', message: '', ...data } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 标记失败（写入失败原因） */
  async markFailed(
    id: string,
    message: string,
    finishedAt: Date,
  ): Promise<AiDetectAsrTaskDocument | null> {
    return AiDetectAsrTaskModel.findOneAndUpdate(
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
  async cancelPending(id: string): Promise<AiDetectAsrTaskDocument | null> {
    return AiDetectAsrTaskModel.findOneAndUpdate(
      { _id: id, status: 'pending', flag: 1 },
      { $set: { status: 'cancelled', stage: 'cancelled', message: '任务已取消', finishedAt: new Date() } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 中断恢复的公共实现：符合 orphanFilter 的孤儿 running 任务重新入队。
   *
   * 重入队而非直接判失败：中断往往发生在进程重启/发布期间，直接判失败会让已转好的块白费
   * （重跑会重新提块，但至少不把用户的任务直接判死）。
   */
  private async requeueOrphan(
    orphanFilter: Record<string, unknown>,
    maxAttempts: number,
    message: string,
  ): Promise<number> {
    const result = await AiDetectAsrTaskModel.updateMany(
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
    const result = await AiDetectAsrTaskModel.updateMany(
      { ...orphanFilter, attempts: { $gte: maxAttempts } },
      { $set: { status: 'failed', stage: 'failed', message, finishedAt: new Date() } },
    ).exec();
    return result.modifiedCount;
  }

  /**
   * 启动 / 接手租约时的孤儿清扫：把**任何 workerId** 的 running 任务重新入队。
   *
   * 依据与另两条队列一致：租约保证全机只有一个调度器，且调度器受各自并发上限约束
   * （调用方已保证此刻本队列没有在途任务），故此刻 Mongo 里本表任何 status=running 的行
   * 都必然是上一代进程遗留的孤儿。
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
   * 阈值必须大于一次完整转写的耗时（长片逐块转写可能很久），否则会把正在跑的长任务误判为孤儿。
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

  /** 待处理任务数（转写队列的深度） */
  async countPending(): Promise<number> {
    return AiDetectAsrTaskModel.countDocuments({ status: 'pending', flag: 1 });
  }

  /** 队列中 createdAt 早于给定时刻的 pending 任务数（+1 即排队位次） */
  async countPendingBefore(createdAt: Date): Promise<number> {
    return AiDetectAsrTaskModel.countDocuments({
      status: 'pending',
      flag: 1,
      createdAt: { $lt: createdAt },
    });
  }

  /** 正在执行的转写任务数（上限为 AI_DETECT_ASR_CONCURRENCY） */
  async countRunning(): Promise<number> {
    return AiDetectAsrTaskModel.countDocuments({ status: 'running', flag: 1 });
  }

  /** 分页查询某用户的转写任务：按创建时间倒序，仅未删除 */
  async findPageByUser(
    query: QueryAiDetectAsrTaskData,
  ): Promise<PaginatedResponse<AiDetectAsrTaskDocument>> {
    const { page, limit } = query;
    const pageNum = Number.isFinite(page) ? Math.max(1, Math.floor(page as number)) : 1;
    const limitNum = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit as number))) : 20;

    const filter: Record<string, unknown> = { flag: 1 };
    if (query.userId) filter.userId = query.userId;
    if (query.status) filter.status = query.status;

    const [list, total] = await Promise.all([
      AiDetectAsrTaskModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      AiDetectAsrTaskModel.countDocuments(filter),
    ]);

    return {
      list: list as unknown as AiDetectAsrTaskDocument[],
      total,
      page: pageNum,
      limit: limitNum,
    };
  }

  /** 按来源场景任务 id 批量查全部转写任务（仅未删除，createdAt 倒序，不分页，供场景任务列表内嵌） */
  async findBySourceTaskIds(sourceTaskIds: string[]): Promise<AiDetectAsrTaskDocument[]> {
    if (sourceTaskIds.length === 0) return [];
    return AiDetectAsrTaskModel.find({ sourceTaskId: { $in: sourceTaskIds }, flag: 1 })
      .sort({ createdAt: -1 })
      .lean() as unknown as AiDetectAsrTaskDocument[];
  }

  /**
   * 同一场景任务是否已有「排队中/执行中」的转写任务。
   *
   * 转写要跑完整的 Whisper 链路（长片还要切十几块），重复提交会成倍占用 subtitle 队列，
   * 故提交时挡住重复请求（已终结的成功/失败任务不算，允许用户补跑）。
   */
  async existsActiveBySourceTask(sourceTaskId: string): Promise<boolean> {
    const count = await AiDetectAsrTaskModel.countDocuments({
      sourceTaskId,
      status: { $in: ['pending', 'running'] },
      flag: 1,
    });
    return count > 0;
  }

  /**
   * 同一场景任务是否存在**任何**转写任务（含已终结的成功/失败/取消）。
   *
   * 与 existsActiveBySourceTask 的差别就是不筛状态：场景合并会改写来源任务的场景划分，
   * 而转写任务已按旧划分归并出 sceneSegments（序号与时间区间都来自旧划分）—— 两者必须
   * 对得上，故只要存在下游记录就不允许再合并（即便它已经跑完或失败）。
   */
  async existsBySourceTask(sourceTaskId: string): Promise<boolean> {
    const count = await AiDetectAsrTaskModel.countDocuments({ sourceTaskId, flag: 1 });
    return count > 0;
  }
}

export const aiDetectAsrTaskRepository = new AiDetectAsrTaskRepository();
