import VoiceSynthesisTaskModel, { type VoiceSynthesisTaskDocument } from './voiceSynthesisTask.entity.ts';

/** 创建任务时的入参（状态由仓库固定为 pending，基础字段由 schema 插件填充默认值） */
export interface CreateVoiceSynthesisTaskData {
    text: string;
    resId: string;
    speed?: number;
    volume?: number;
    pitch?: number;
    language?: number;
    encoding?: string;
    sampleRate?: number;
    startedAt?: Date;
    userId?: string;
}

class VoiceSynthesisTaskRepository {
  /** 创建合成任务（pending） */
  async create(data: CreateVoiceSynthesisTaskData): Promise<VoiceSynthesisTaskDocument> {
    return VoiceSynthesisTaskModel.create({ ...data, status: 'pending' });
  }

  /** 按 id 查找任务（仅未删除） */
  async findById(id: string): Promise<VoiceSynthesisTaskDocument | null> {
    return VoiceSynthesisTaskModel.findOne({ _id: id, flag: 1 }).exec();
  }

  /**
   * 原子领取任务：仅当当前为 pending 时才置为 running。
   * 返回 null 表示已被其他执行体领取/执行，防止多实例重复合成。
   */
  async claimRunning(id: string): Promise<VoiceSynthesisTaskDocument | null> {
    return VoiceSynthesisTaskModel.findByIdAndUpdate(
      id,
      { $set: { status: 'running' } },
      { returnDocument: 'after', runValidators: true },
    ).where({ status: 'pending' }).exec();
  }

  /** 标记成功（写入文件结果） */
  async markSuccess(
    id: string,
    data: { resultFileId: string; resultUrl: string; finishedAt: Date },
  ): Promise<VoiceSynthesisTaskDocument | null> {
    return VoiceSynthesisTaskModel.findByIdAndUpdate(
      id,
      { $set: { status: 'success', ...data } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
  }

  /** 标记失败（写入失败原因） */
  async markFailed(id: string, message: string, finishedAt: Date): Promise<VoiceSynthesisTaskDocument | null> {
    return VoiceSynthesisTaskModel.findByIdAndUpdate(
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
    const result = await VoiceSynthesisTaskModel.updateMany(
      { status: 'running', updatedAt: { $lt: staleBefore }, flag: 1 },
      { $set: { status: 'failed', message, finishedAt: new Date() } },
    ).exec();
    return result.modifiedCount;
  }
}

export const voiceSynthesisTaskRepository = new VoiceSynthesisTaskRepository();
