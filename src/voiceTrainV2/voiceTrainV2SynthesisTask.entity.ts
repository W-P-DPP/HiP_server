import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 合成任务状态：pending 待领取 / running 执行中 / success 成功 / failed 失败 / cancelled 已取消 */
export type VoiceTrainV2SynthesisStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/**
 * 音色克隆合成任务。
 *
 * 提交接口只建 pending 记录并立即返回 taskId，真正执行的是「全机唯一」的 leader
 * dispatcher（音色克隆只有一个 GPU 常驻模型，不能每个 cluster worker 各跑一份）。
 */
export interface IVoiceTrainV2SynthesisTask extends IBaseMongoEntity {
  status: VoiceTrainV2SynthesisStatus;
  /** 音色库记录 id（voiceTrainV2Voices） */
  voiceId: string;
  /** 待合成文本（入参快照） */
  text: string;
  /** 速度档位：fast / balanced / quality */
  speedMode: string;
  /**
   * 任务用途：preview 试听 / synthesis 正式合成。缺省 synthesis。
   * 只有 preview 成功后会把结果回写到音色试听字段（见 indexttsDispatcher.persistResult）。
   */
  purpose: string;

  /** 执行期状态 */
  /** 进度 0..1，直接透传 worker 的 @@PROGRESS@@ 值 */
  progress: number;
  /** ASCII 阶段 key（config / indextts_load / indextts_ready / indextts_synth / done / failed） */
  stage: string;
  /** 人类可读描述；失败原因也写这里 */
  message: string;
  /** 执行进程标识（排障用：哪个 cluster worker 跑的） */
  workerId: string;
  /** 被领取次数；>1 说明经历过中断重领 */
  attempts: number;

  /** 结果 */
  resultFileId: string;
  /** 试听地址，形如 /api/files/<id>/download */
  resultUrl: string;
  /** 产出音频时长（秒） */
  duration: number;

  startedAt?: Date;
  finishedAt?: Date;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 合成任务 Mongoose Document 类型 */
export type VoiceTrainV2SynthesisTaskDocument = BaseDocument & IVoiceTrainV2SynthesisTask;

const VoiceTrainV2SynthesisTaskSchema = new mongoose.Schema<VoiceTrainV2SynthesisTaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    voiceId: { type: String, required: true, index: true },
    text: { type: String, required: true },
    speedMode: { type: String, default: 'balanced' },
    purpose: { type: String, enum: ['preview', 'synthesis'], default: 'synthesis' },
    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    resultFileId: { type: String, default: '' },
    resultUrl: { type: String, default: '' },
    duration: { type: Number, default: 0 },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'voiceTrainV2SynthesisTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
VoiceTrainV2SynthesisTaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
VoiceTrainV2SynthesisTaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
VoiceTrainV2SynthesisTaskSchema.index({ userId: 1, createdAt: -1 });

const VoiceTrainV2SynthesisTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<VoiceTrainV2SynthesisTaskDocument>('VoiceTrainV2SynthesisTask', VoiceTrainV2SynthesisTaskSchema);

export default VoiceTrainV2SynthesisTaskModel;
