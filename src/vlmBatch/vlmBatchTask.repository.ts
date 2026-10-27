import VlmBatchTaskModel, { type VlmBatchTaskDocument } from './vlmBatchTask.entity.ts';
import type {
  CompleteVlmBatchItemData,
  CompleteVlmBatchTaskData,
  CreateVlmBatchTaskData,
  QueryVlmBatchTaskData,
} from './vlmBatch.dto.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';

/**
 * 批量图像识别任务仓储。
 *
 * 方法名与 `vlmTask.repository.ts` / `aiDetectFrameTask.repository.ts` 保持一致
 * （claimNextPending / markSuccess / requeueOrphanRunning / …），使各调度器的恢复语义可横向对照。
 * 与单图仓储的唯一结构性差别是多了 `updateItemResult` —— 批次要在执行中逐项回写结果。
 */
class VlmBatchTaskRepository {
  /** 创建批量识别任务（pending，进度归零，items 逐项置 pending） */
  async create(data: CreateVlmBatchTaskData): Promise<VlmBatchTaskDocument> {
    return VlmBatchTaskModel.create({
      sourceType: data.sourceType,
      sourceTaskId: data.sourceTaskId,
      sourceFileId: data.sourceFileId,
      sourceUrl: data.sourceUrl,
      originalName: data.originalName,
      prompt: data.prompt,
      mode: data.mode,
      total: data.total,
      // 显式补全每项的结果字段，使落库形态与 schema 一致（不依赖 schema default 逐字段填）
      items: data.items.map((item) => ({
        ...item,
        status: 'pending' as const,
        rawText: '',
        message: '',
        modelCalls: 0,
        modelId: '',
        elapsedMs: 0,
      })),
      status: 'pending',
      progress: 0,
      stage: 'pending',
      message: '',
      workerId: '',
      attempts: 0,
      succeeded: 0,
      failed: 0,
      userId: data.userId ?? '',
    });
  }

  /** 按主键查找任务（仅未删除） */
  async findById(id: string): Promise<VlmBatchTaskDocument | null> {
    return VlmBatchTaskModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /**
   * 原子领取「最老的一条 pending 任务」并置为 running。
   *
   * 单条 findOneAndUpdate 保证同一任务在并发下只会被一个执行体拿到；配合 leader 租约
   * （全机只有一个 dispatcher）即构成完整的互斥。返回 null 表示当前没有待处理任务。
   *
   * 注意 `flag` 必须放在 filter 里 —— 它是 select:false 字段，放 projection 不生效。
   */
  async claimNextPending(workerId: string): Promise<VlmBatchTaskDocument | null> {
    return VlmBatchTaskModel.findOneAndUpdate(
      { status: 'pending', flag: 1 },
      { $set: { status: 'running', startedAt: new Date(), workerId }, $inc: { attempts: 1 } },
      { returnDocument: 'after', sort: { createdAt: 1 }, runValidators: true },
    ).exec();
  }

  /**
   * 更新整批进度。限定 status=running，避免任务已进入终态后仍被迟到的进度回调覆盖。
   */
  async updateProgress(
    id: string,
    data: { progress: number; stage: string; message: string },
  ): Promise<VlmBatchTaskDocument | null> {
    return VlmBatchTaskModel.findOneAndUpdate(
      { _id: id, status: 'running', flag: 1 },
      { $set: data },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 回写单个识别项的结果（按 items.index 定位）。
   *
   * 用位置操作符 `items.$.` —— 查询条件里的 `items.index` 命中的那个元素，正是 `$` 指向的元素，
   * 无需 arrayFilters。限定 status=running：任务被取消/终结后，迟到的单项回调不应再改动记录。
   * 返回 modifiedCount 为 0 表示任务已非 running（或该项不存在），调用方据此判断是否被打断。
   */
  async updateItemResult(
    id: string,
    index: number,
    data: CompleteVlmBatchItemData,
  ): Promise<number> {
    const set: Record<string, unknown> = {
      'items.$.status': data.status,
      'items.$.rawText': data.rawText,
      'items.$.message': data.message,
      'items.$.modelCalls': data.modelCalls,
      'items.$.modelId': data.modelId,
      'items.$.elapsedMs': data.elapsedMs,
    };
    const update: Record<string, unknown> = { $set: set };
    // 结果字段只在成功且 json 形态时存在；其余情况必须显式清掉，避免重跑后残留上一次的结果
    if (data.result) set['items.$.result'] = data.result;
    else update.$unset = { 'items.$.result': 1 };

    const result = await VlmBatchTaskModel.updateOne(
      { _id: id, status: 'running', 'items.index': index, flag: 1 },
      update,
      { runValidators: true },
    ).exec();
    return result.modifiedCount;
  }

  /** 标记成功（写入计数与耗时，进度置满） */
  async markSuccess(
    id: string,
    data: CompleteVlmBatchTaskData,
  ): Promise<VlmBatchTaskDocument | null> {
    return VlmBatchTaskModel.findOneAndUpdate(
      { _id: id, flag: 1 },
      {
        $set: {
          status: 'success',
          progress: 1,
          stage: 'done',
          message: '',
          succeeded: data.succeeded,
          failed: data.failed,
          finishedAt: data.finishedAt,
        },
      },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 标记失败（写入失败原因）。
   *
   * `counts` 可选：整批失败时若已有部分项成功/失败（如全部失败），把计数一并落库，
   * 否则调用方只能从 items 里自己数。前置失败（来源任务缺失/配置缺失）无计数可传，则不写。
   */
  async markFailed(
    id: string,
    message: string,
    finishedAt: Date,
    counts?: { succeeded: number; failed: number },
  ): Promise<VlmBatchTaskDocument | null> {
    return VlmBatchTaskModel.findOneAndUpdate(
      { _id: id, flag: 1 },
      {
        $set: {
          status: 'failed',
          stage: 'failed',
          message,
          finishedAt,
          ...(counts ? { succeeded: counts.succeeded, failed: counts.failed } : {}),
        },
      },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 取消一条排队中的任务。
   *
   * 与 claimNextPending 同以 status='pending' 为条件，故二者对同一条记录互斥：取消成功后
   * dispatcher 不再能领取它。返回 null 表示任务当前不是 pending（已被领取或已是终态）。
   */
  async cancelPending(id: string): Promise<VlmBatchTaskDocument | null> {
    return VlmBatchTaskModel.findOneAndUpdate(
      { _id: id, status: 'pending', flag: 1 },
      { $set: { status: 'cancelled', stage: 'cancelled', message: '任务已取消', finishedAt: new Date() } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 中断恢复的公共实现：符合 orphanFilter 的孤儿 running 任务重新入队。
   *
   * 重入队而非直接判失败：中断往往发生在进程重启/发布期间，此时容器侧可能已完成部分关键帧
   * （单项结果按 `client_job_id = taskId:index` 幂等，重投命中同一 job、不重复消耗 GPU）。
   * 重排后 execute 会跳过已 success 的项（断点续跑），只补跑未完成的。
   */
  private async requeueOrphan(
    orphanFilter: Record<string, unknown>,
    maxAttempts: number,
    message: string,
  ): Promise<number> {
    const result = await VlmBatchTaskModel.updateMany(
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
    const result = await VlmBatchTaskModel.updateMany(
      { ...orphanFilter, attempts: { $gte: maxAttempts } },
      { $set: { status: 'failed', stage: 'failed', message, finishedAt: new Date() } },
    ).exec();
    return result.modifiedCount;
  }

  /**
   * 启动 / 接手租约时的孤儿清扫：把**任何 workerId** 的 running 任务重新入队。
   *
   * 依据：租约保证全机只有一个调度器，且调度器受 concurrency 约束（调用方已保证此刻没有
   * 在途任务）。因此此刻 Mongo 里任何 status=running 的行都必然是上一代进程遗留的孤儿，
   * 可以立即重排，不必等陈旧阈值。不能只用 workerId 匹配 —— cluster 重启后 worker id 会
   * 重新从 1 分配，旧进程写的 id 未必等于新 leader 的 id。
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
   * 阈值必须大于一次完整批次的耗时，否则会把正在跑的批次误判为孤儿（见 vlmBatch.config.ts）。
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
    return VlmBatchTaskModel.countDocuments({ status: 'pending', flag: 1 });
  }

  /** 队列中 createdAt 早于给定时刻的 pending 任务数（+1 即排队位次） */
  async countPendingBefore(createdAt: Date): Promise<number> {
    return VlmBatchTaskModel.countDocuments({
      status: 'pending',
      flag: 1,
      createdAt: { $lt: createdAt },
    });
  }

  /** 正在执行的任务数（上限为 VLM_BATCH_CONCURRENCY） */
  async countRunning(): Promise<number> {
    return VlmBatchTaskModel.countDocuments({ status: 'running', flag: 1 });
  }

  /** 分页查询某用户的任务：按创建时间倒序，仅未删除 */
  async findPageByUser(
    query: QueryVlmBatchTaskData,
  ): Promise<PaginatedResponse<VlmBatchTaskDocument>> {
    const { page, limit } = query;
    const pageNum = Number.isFinite(page) ? Math.max(1, Math.floor(page as number)) : 1;
    const limitNum = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit as number))) : 20;

    const filter: Record<string, unknown> = { flag: 1 };
    if (query.userId) filter.userId = query.userId;
    if (query.status) filter.status = query.status;

    const [list, total] = await Promise.all([
      VlmBatchTaskModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      VlmBatchTaskModel.countDocuments(filter),
    ]);

    return { list: list as unknown as VlmBatchTaskDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 按来源抽帧任务 id 批量查全部批量识别任务（仅未删除，createdAt 倒序，不分页，供场景任务列表内嵌） */
  async findBySourceTaskIds(sourceTaskIds: string[]): Promise<VlmBatchTaskDocument[]> {
    if (sourceTaskIds.length === 0) return [];
    return VlmBatchTaskModel.find({ sourceTaskId: { $in: sourceTaskIds }, flag: 1 })
      .sort({ createdAt: -1 })
      .lean() as unknown as VlmBatchTaskDocument[];
  }

  /**
   * 同一抽帧任务是否已有「排队中/执行中」的批量识别任务。
   *
   * 一个批次会把全部关键帧逐张送容器，重复提交会成倍地消耗 GPU，故提交时用它挡住重复请求
   * （已终结的成功/失败任务不算，允许用户对同一抽帧任务再识别一次）。
   */
  async existsActiveBySourceTask(sourceTaskId: string): Promise<boolean> {
    const count = await VlmBatchTaskModel.countDocuments({
      sourceTaskId,
      status: { $in: ['pending', 'running'] },
      flag: 1,
    });
    return count > 0;
  }
}

export const vlmBatchTaskRepository = new VlmBatchTaskRepository();
