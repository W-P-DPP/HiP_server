import VoicePipelineTaskModel, { type VoicePipelineTaskDocument, type VoicePipelineTaskStatus } from './voicePipelineTask.entity.ts';
import type { PaginatedResponse } from '../file/file.dto.ts';

/** 创建管道任务时的入参（状态由仓库固定为 pending，基础字段由 schema 插件填充默认值） */
export interface CreateVoicePipelineTaskData {
    text: string;
    resId: string;
    speed?: number;
    volume?: number;
    pitch?: number;
    language?: number;
    encoding?: string;
    sampleRate?: number;
    color?: string;
    keywords?: string[];
    startedAt?: Date;
    userId?: string;
}

/** 标记成功时写入的结果字段 */
export interface PipelineTaskSuccessData {
    audioFileId?: string;
    audioUrl?: string;
    srtFileId?: string;
    srtUrl?: string;
    assFileId?: string;
    assUrl?: string;
    videoFileId?: string;
    videoUrl?: string;
    message?: string;
    finishedAt: Date;
}

class VoicePipelineTaskRepository {
  /** 创建管道任务（pending） */
  async create(data: CreateVoicePipelineTaskData): Promise<VoicePipelineTaskDocument> {
    return VoicePipelineTaskModel.create({ ...data, status: 'pending' });
  }

  /** 按 id 查找任务（仅未删除） */
  async findById(id: string): Promise<VoicePipelineTaskDocument | null> {
    return VoicePipelineTaskModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /** 分页查询当前用户的视频生成任务（按创建时间倒序，仅未删除；taskId 对 _id 字符串模糊匹配） */
  async listByUserId(
    userId: string,
    query: { page?: number; limit?: number; taskId?: string },
  ): Promise<PaginatedResponse<VoicePipelineTaskDocument>> {
    const { page = 1, limit = 20, taskId } = query;
    const pageNum = Math.max(1, page);
    const limitNum = Math.min(100, Math.max(1, limit));

    const filter: Record<string, unknown> = { userId, flag: 1 };
    if (taskId) {
      // _id 为 ObjectId 无法直接 $regex，需先转字符串再模糊匹配（$expr 可同时用于 find 与 countDocuments）
      filter.$expr = {
        $regexMatch: {
          input: { $toString: '$_id' },
          regex: VoicePipelineTaskRepository.escapeRegex(taskId),
          options: 'i',
        },
      };
    }

    const [list, total] = await Promise.all([
      VoicePipelineTaskModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      VoicePipelineTaskModel.countDocuments(filter),
    ]);

    return { list: list as unknown as VoicePipelineTaskDocument[], total, page: pageNum, limit: limitNum };
  }

  /** 统计某状态下未删除任务数（status 精确匹配 + flag=1，供跨进程队列状态全局聚合） */
  async countByStatus(status: VoicePipelineTaskStatus): Promise<number> {
    return VoicePipelineTaskModel.countDocuments({ status, flag: 1 });
  }

  /**
   * 原子领取任务：仅当当前为 pending 时才置为 running。
   * 返回 null 表示已被其他执行体领取/执行，防止多实例重复执行。
   */
  async claimRunning(id: string): Promise<VoicePipelineTaskDocument | null> {
    return VoicePipelineTaskModel.findByIdAndUpdate(
      id,
      { $set: { status: 'running' } },
      { returnDocument: 'after', runValidators: true },
    ).where({ status: 'pending' }).exec();
  }

  /** 标记成功（写入音频/字幕/视频结果） */
  async markSuccess(
    id: string,
    data: PipelineTaskSuccessData,
  ): Promise<VoicePipelineTaskDocument | null> {
    return VoicePipelineTaskModel.findByIdAndUpdate(
      id,
      { $set: { status: 'success', ...data } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 标记失败（写入失败原因） */
  async markFailed(id: string, message: string, finishedAt: Date): Promise<VoicePipelineTaskDocument | null> {
    return VoicePipelineTaskModel.findByIdAndUpdate(
      id,
      { $set: { status: 'failed', message, finishedAt } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /**
   * 服务重启恢复：把「status=running 且 updatedAt 早于 staleBefore」的遗留任务标记 failed。
   * 阈值防止误杀多进程下仍执行中的任务（timestamps 保证 updatedAt≈领取时间，运行期不再变化）；
   * flag:1 过滤遵循仓库查询规范。
   */
  async recoverStuckRunning(message: string, staleBefore: Date): Promise<number> {
    const result = await VoicePipelineTaskModel.updateMany(
      { status: 'running', updatedAt: { $lt: staleBefore }, flag: 1 },
      { $set: { status: 'failed', message, finishedAt: new Date() } },
    ).exec();
    return result.modifiedCount;
  }

  /** 转义正则元字符，避免 taskId 关键字作为正则表达式被解析 */
  private static escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export const voicePipelineTaskRepository = new VoicePipelineTaskRepository();
