import NarrationVideoTaskModel, {
  type INarrationSegmentState,
  type NarrationVideoTaskDocument,
} from './narrationVideoTask.entity.ts';
import type { CreateNarrationVideoTaskData, QueryNarrationVideoTaskData } from './narrationVideo.dto.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';

/** 标记成功时写入的产物字段 */
export interface NarrationVideoSuccessData {
  srtFileId: string;
  srtUrl: string;
  cueCount: number;
  videoFileId: string;
  videoUrl: string;
  videoDuration: number;
  finishedAt: Date;
}

class NarrationVideoTaskRepository {
  /** 创建解说视频任务（pending，进度归零；segmentStates 预先占位，逐段 $set 更新） */
  async create(data: CreateNarrationVideoTaskData): Promise<NarrationVideoTaskDocument> {
    return NarrationVideoTaskModel.create({
      ...data,
      status: 'pending',
      progress: 0,
      stage: 'pending',
      message: '',
      workerId: '',
      attempts: 0,
      // 逐段占位：执行期按 `segmentStates.<i>` 直接 $set，避免越界写时被 MongoDB 补 null 填充
      segmentStates: data.segments.map((segment, i) => ({
        index: segment.index || i + 1,
        voiceTaskId: '',
        audioFileId: '',
        audioUrl: '',
        audioDurationMs: 0,
      })),
      srtFileId: '',
      srtUrl: '',
      cueCount: 0,
      videoFileId: '',
      videoUrl: '',
      videoDuration: 0,
      userId: data.userId ?? '',
    });
  }

  /** 按主键查找任务（仅未删除） */
  async findById(id: string): Promise<NarrationVideoTaskDocument | null> {
    return NarrationVideoTaskModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /**
   * 原子领取「最老的一条 pending 任务」并置为 running。
   *
   * 单条 findOneAndUpdate 保证同一任务在并发下只会被一个执行体拿到；配合 leader 租约
   * （全机只有一个 dispatcher）即构成完整的互斥。返回 null 表示当前没有待处理任务。
   */
  async claimNextPending(workerId: string): Promise<NarrationVideoTaskDocument | null> {
    return NarrationVideoTaskModel.findOneAndUpdate(
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
  ): Promise<NarrationVideoTaskDocument | null> {
    return NarrationVideoTaskModel.findOneAndUpdate(
      { _id: id, status: 'running', flag: 1 },
      { $set: data },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 记录某段的执行期状态（配音子任务 id + 音频产物）。
   *
   * index 为 0 基下标（与 segmentStates 数组位置一致）；create 时已按分段数占好位，
   * 故这里用带下标的 `$set` 直接覆盖对应元素。
   */
  async setSegmentState(
    id: string,
    index: number,
    data: INarrationSegmentState,
  ): Promise<NarrationVideoTaskDocument | null> {
    return NarrationVideoTaskModel.findOneAndUpdate(
      { _id: id, status: 'running', flag: 1 },
      { $set: { [`segmentStates.${index}`]: data } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 记录字幕与成片产物前的中间产物（字幕 SRT） */
  async setSubtitle(
    id: string,
    data: { srtFileId: string; srtUrl: string; cueCount: number },
  ): Promise<NarrationVideoTaskDocument | null> {
    return NarrationVideoTaskModel.findOneAndUpdate(
      { _id: id, status: 'running', flag: 1 },
      { $set: data },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 标记成功（写入字幕/成片产物，进度置满） */
  async markSuccess(
    id: string,
    data: NarrationVideoSuccessData,
  ): Promise<NarrationVideoTaskDocument | null> {
    return NarrationVideoTaskModel.findOneAndUpdate(
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
  ): Promise<NarrationVideoTaskDocument | null> {
    return NarrationVideoTaskModel.findOneAndUpdate(
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
  async cancelPending(id: string): Promise<NarrationVideoTaskDocument | null> {
    return NarrationVideoTaskModel.findOneAndUpdate(
      { _id: id, status: 'pending', flag: 1 },
      { $set: { status: 'cancelled', stage: 'cancelled', message: '任务已取消', finishedAt: new Date() } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 中断恢复的公共实现：符合 orphanFilter 的孤儿 running 任务重新入队。
   *
   * 重入队而非直接判失败：中断往往发生在进程重启/发布期间，此时配音子任务可能已完成或仍在跑，
   * 直接判失败会白费一次 GPU 合成。重排回 pending 后由调度器续跑，execute 会复用已提交的
   * segmentStates[].voiceTaskId。
   */
  private async requeueOrphan(
    orphanFilter: Record<string, unknown>,
    maxAttempts: number,
    message: string,
  ): Promise<number> {
    const result = await NarrationVideoTaskModel.updateMany(
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
    const result = await NarrationVideoTaskModel.updateMany(
      { ...orphanFilter, attempts: { $gte: maxAttempts } },
      { $set: { status: 'failed', stage: 'failed', message, finishedAt: new Date() } },
    ).exec();
    return result.modifiedCount;
  }

  /**
   * 启动 / 接手租约时的孤儿清扫：把**任何 workerId** 的 running 任务重新入队。
   *
   * 依据：租约保证全机只有一个调度器，且调度器受 concurrency 约束（调用方已保证此刻没有
   * 在途任务）。因此此刻 Mongo 里任何 status=running 的行都必然是上一代进程遗留的孤儿。
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
   * 阈值必须大于一次完整任务耗时（N 段配音 + 合成），否则会把正在跑的长任务误判为孤儿。
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
    return NarrationVideoTaskModel.countDocuments({ status: 'pending', flag: 1 });
  }

  /** 队列中 createdAt 早于给定时刻的 pending 任务数（+1 即排队位次） */
  async countPendingBefore(createdAt: Date): Promise<number> {
    return NarrationVideoTaskModel.countDocuments({
      status: 'pending',
      flag: 1,
      createdAt: { $lt: createdAt },
    });
  }

  /** 正在执行的任务数（上限为 NARRATION_VIDEO_CONCURRENCY） */
  async countRunning(): Promise<number> {
    return NarrationVideoTaskModel.countDocuments({ status: 'running', flag: 1 });
  }

  /** 分页查询某用户的任务：按创建时间倒序，仅未删除 */
  async findPageByUser(
    query: QueryNarrationVideoTaskData,
  ): Promise<PaginatedResponse<NarrationVideoTaskDocument>> {
    const { page, limit } = query;
    const pageNum = Number.isFinite(page) ? Math.max(1, Math.floor(page as number)) : 1;
    const limitNum = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit as number))) : 20;

    const filter: Record<string, unknown> = { flag: 1 };
    if (query.userId) filter.userId = query.userId;
    if (query.status) filter.status = query.status;

    const [list, total] = await Promise.all([
      NarrationVideoTaskModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      NarrationVideoTaskModel.countDocuments(filter),
    ]);

    return { list: list as unknown as NarrationVideoTaskDocument[], total, page: pageNum, limit: limitNum };
  }
}

export const narrationVideoTaskRepository = new NarrationVideoTaskRepository();
