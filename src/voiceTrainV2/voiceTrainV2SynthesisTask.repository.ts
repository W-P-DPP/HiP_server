import VoiceTrainV2SynthesisTaskModel, {
  type VoiceTrainV2SynthesisTaskDocument,
  type VoiceTrainV2SynthesisStatus,
} from './voiceTrainV2SynthesisTask.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';

/** 创建任务时的入参（状态由仓库固定为 pending） */
export interface CreateVoiceTrainV2SynthesisTaskData {
  voiceId: string;
  text: string;
  speedMode: string;
  /** 任务用途：preview 试听 / synthesis 正式合成 */
  purpose: string;
  userId?: string;
}

/** 查询入参：userId 精确 + status 可选，分页 page/limit */
export interface QueryVoiceTrainV2SynthesisTaskData {
  userId?: string;
  status?: VoiceTrainV2SynthesisStatus;
  page?: number;
  limit?: number;
}

class VoiceTrainV2SynthesisTaskRepository {
  /** 创建合成任务（pending，进度归零） */
  async create(data: CreateVoiceTrainV2SynthesisTaskData): Promise<VoiceTrainV2SynthesisTaskDocument> {
    return VoiceTrainV2SynthesisTaskModel.create({
      ...data,
      status: 'pending',
      progress: 0,
      stage: 'pending',
      message: '',
      workerId: '',
      attempts: 0,
      userId: data.userId ?? '',
    });
  }

  /** 按主键查找任务（仅未删除） */
  async findById(id: string): Promise<VoiceTrainV2SynthesisTaskDocument | null> {
    return VoiceTrainV2SynthesisTaskModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /**
   * 原子领取「最老的一条 pending 任务」并置为 running。
   *
   * 单条 findOneAndUpdate 保证同一任务在并发下只会被一个执行体拿到；配合 leader 租约
   * （全机只有一个 dispatcher）即构成完整的互斥。返回 null 表示当前没有待处理任务。
   *
   * 注意 `flag` 必须放在 filter 里 —— 它是 select:false 字段，放 projection 不生效。
   */
  async claimNextPending(workerId: string): Promise<VoiceTrainV2SynthesisTaskDocument | null> {
    return VoiceTrainV2SynthesisTaskModel.findOneAndUpdate(
      { status: 'pending', flag: 1 },
      { $set: { status: 'running', startedAt: new Date(), workerId }, $inc: { attempts: 1 } },
      { returnDocument: 'after', sort: { createdAt: 1 }, runValidators: true },
    ).exec();
  }

  /**
   * 更新执行进度。限定 status=running，避免任务已进入终态后仍被迟到的进度回调覆盖。
   * 返回 null 表示任务已被终结（或不存在），调用方据此停止上报。
   */
  async updateProgress(
    id: string,
    data: { progress: number; stage: string; message: string },
  ): Promise<VoiceTrainV2SynthesisTaskDocument | null> {
    return VoiceTrainV2SynthesisTaskModel.findOneAndUpdate(
      { _id: id, status: 'running', flag: 1 },
      { $set: data },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 标记成功（写入产物信息，进度置满） */
  async markSuccess(
    id: string,
    data: { resultFileId: string; resultUrl: string; duration: number; finishedAt: Date },
  ): Promise<VoiceTrainV2SynthesisTaskDocument | null> {
    return VoiceTrainV2SynthesisTaskModel.findOneAndUpdate(
      { _id: id, flag: 1 },
      { $set: { status: 'success', progress: 1, stage: 'done', message: '', ...data } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 标记失败（写入失败原因） */
  async markFailed(id: string, message: string, finishedAt: Date): Promise<VoiceTrainV2SynthesisTaskDocument | null> {
    return VoiceTrainV2SynthesisTaskModel.findOneAndUpdate(
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
  async cancelPending(id: string): Promise<VoiceTrainV2SynthesisTaskDocument | null> {
    return VoiceTrainV2SynthesisTaskModel.findOneAndUpdate(
      { _id: id, status: 'pending', flag: 1 },
      { $set: { status: 'cancelled', stage: 'cancelled', message: '任务已取消', finishedAt: new Date() } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 中断恢复的公共实现：符合 orphanFilter 的孤儿 running 任务重新入队。
   *
   * 重入队而非直接判失败：远端作业以 clientJobId(= taskId) 幂等，重投会命中同一作业 ——
   * 已完成的直接下产物、仍在跑的续等，都不会重复消耗 GPU。只有 attempts 未达上限的才入队。
   */
  private async requeueOrphan(
    orphanFilter: Record<string, unknown>,
    maxAttempts: number,
    message: string,
  ): Promise<number> {
    const result = await VoiceTrainV2SynthesisTaskModel.updateMany(
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
    const result = await VoiceTrainV2SynthesisTaskModel.updateMany(
      { ...orphanFilter, attempts: { $gte: maxAttempts } },
      { $set: { status: 'failed', stage: 'failed', message, finishedAt: new Date() } },
    ).exec();
    return result.modifiedCount;
  }

  /**
   * 启动 / 接手租约时的孤儿清扫：把**任何 workerId** 的 running 任务重新入队。
   *
   * 依据：租约保证全机只有一个调度器，且调度器单飞（同一时刻至多一条在途任务）。
   * 因此当调度器持有租约、自己又没有在途任务时，Mongo 里任何 status=running 的行
   * 都必然是上一代进程遗留的孤儿，可以立即重排，不必等陈旧阈值。
   *
   * 不能只用 workerId 匹配：cluster 重启后 worker id 会重新从 1 分配，旧进程写的 id
   * 未必等于新 leader 的 id，孤儿只能干等到 taskStaleMs（默认 90 分钟）才被陈旧扫描收走。
   * 调用方需保证此刻本进程没有在跑任务。
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
   * 阈值必须大于「冷启动 + 单个合成任务」的总时长（默认 30 分钟）—— 模型首次加载要 1–3 分钟，
   * 阈值取小了会把正在跑的任务误判为孤儿。
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
    return VoiceTrainV2SynthesisTaskModel.countDocuments({ status: 'pending', flag: 1 });
  }

  /**
   * 队列中 createdAt 早于给定时刻的 pending 任务数。
   *
   * 与 claimNextPending 的领取顺序（createdAt 升序取最老）严格对应，故返回值 +1 即为排队位次。
   * 走已有索引 { status: 1, createdAt: 1 }。
   */
  async countPendingBefore(createdAt: Date): Promise<number> {
    return VoiceTrainV2SynthesisTaskModel.countDocuments({
      status: 'pending',
      flag: 1,
      createdAt: { $lt: createdAt },
    });
  }

  /** 正在执行的任务数（把占着 GPU 的那条计入「前方还需等待」；并发度恒为 1，通常 0 或 1） */
  async countRunning(): Promise<number> {
    return VoiceTrainV2SynthesisTaskModel.countDocuments({ status: 'running', flag: 1 });
  }

  /** 分页查询某用户的任务：按创建时间倒序，仅未删除 */
  async findPageByUser(
    query: QueryVoiceTrainV2SynthesisTaskData,
  ): Promise<PaginatedResponse<VoiceTrainV2SynthesisTaskDocument>> {
    const { page, limit } = query;
    const pageNum = Number.isFinite(page) ? Math.max(1, Math.floor(page as number)) : 1;
    const limitNum = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit as number))) : 20;

    const filter: Record<string, unknown> = { flag: 1 };
    if (query.userId) filter.userId = query.userId;
    if (query.status) filter.status = query.status;

    const [list, total] = await Promise.all([
      VoiceTrainV2SynthesisTaskModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      VoiceTrainV2SynthesisTaskModel.countDocuments(filter),
    ]);

    return { list: list as unknown as VoiceTrainV2SynthesisTaskDocument[], total, page: pageNum, limit: limitNum };
  }
}

export const voiceTrainV2SynthesisTaskRepository = new VoiceTrainV2SynthesisTaskRepository();
