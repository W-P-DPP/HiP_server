import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { Vlm } from '../../type/index.d.ts';

/** 任务状态：pending 待领取 / running 执行中 / success 成功 / failed 失败 / cancelled 已取消 */
export type VlmTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/** 提交口径：upload 上传文件 / fileId 引用已有记录 */
export type VlmSourceType = 'upload' | 'fileId';

/** 输出形态：json 结构化 / text 自由文本 */
export type VlmMode = 'json' | 'text';

/**
 * 结构化理解结果（内嵌值对象）。
 *
 * 落库前一定经过 `normalizeVlmResult` 收敛，因此这里声明的是「收敛后」的形态：
 * 数组非空元素、sceneType 已归一。description 缺省时不会写这个子文档（任务直接判失败）。
 */
interface IVlmResult {
  description: string;
  objects: string[];
  actions: string[];
  sceneType: string;
  tags: string[];
}

/**
 * 图片理解任务。
 *
 * 提交接口只建 pending 记录并立即返回 taskId，真正执行的是「全机唯一」的 leader
 * dispatcher（见 vlmDispatcher.ts）。执行体本身不持有模型：它把图片 HTTP 发给独立的
 * Qwen3-VL 容器（services/vlm），只负责提交、轮询、校验与落库。
 */
export interface IVlmTask extends IBaseMongoEntity {
  status: VlmTaskStatus;

  /** 提交口径（排障用） */
  sourceType: VlmSourceType;
  /** 源图片 file 记录 id */
  sourceFileId: string;
  /** 源图片下载地址，形如 /api/files/<id>/download */
  sourceUrl: string;
  /** 源图片原始文件名 */
  originalName: string;

  /** 实际下发的指令（缺省值已落库，便于复现同一张图的不同措辞效果） */
  prompt: string;
  /** 输出形态 */
  mode: VlmMode;

  /** 执行期状态 */
  /** 进度 0..1 */
  progress: number;
  /** ASCII 阶段 key（见 utils/constant/vlm.ts 的映射） */
  stage: string;
  /** 人类可读描述；失败原因也写这里 */
  message: string;
  /** 执行进程标识（排障用：哪个 cluster worker 跑的） */
  workerId: string;
  /** 被领取次数；>1 说明经历过中断重领 */
  attempts: number;

  /** 结果 */
  /** 结构化结果（仅 mode=json 且成功时存在） */
  result?: IVlmResult;
  /** 模型原始输出（排障用；JSON 解析失败时它是唯一线索） */
  rawText: string;
  /** 容器侧实际调用模型的次数（1=一次通过，2=首轮 JSON 不可解析后重试过） */
  modelCalls: number;
  /**
   * 容器侧实际使用的模型 id（运行时可换权重，记下来才知道这条结果是谁算的）。
   *
   * 刻意不叫 `model`：Mongoose Document 上已有 `model()` 方法，同名 schema 路径会被
   * Schema 泛型拒绝（TS2561 "model does not exist in type"）。
   */
  modelId: string;
  /** 推理耗时（ms） */
  elapsedMs: number;

  startedAt?: Date;
  finishedAt?: Date;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 图片理解任务 Mongoose Document 类型 */
export type VlmTaskDocument = BaseDocument & IVlmTask;

const VlmResultSchema = new mongoose.Schema<IVlmResult>(
  {
    description: { type: String, required: true },
    objects: { type: [String], default: [] },
    actions: { type: [String], default: [] },
    sceneType: { type: String, default: 'other' },
    tags: { type: [String], default: [] },
  },
  // 结果是任务的内嵌值对象，没有独立身份，不需要 _id
  { _id: false },
);

const VlmTaskSchema = new mongoose.Schema<VlmTaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    sourceType: {
      type: String,
      enum: ['upload', 'fileId'],
      default: 'fileId',
    },
    sourceFileId: { type: String, required: true, index: true },
    sourceUrl: { type: String, default: '' },
    originalName: { type: String, default: '' },

    prompt: { type: String, default: '' },
    mode: { type: String, enum: ['json', 'text'], default: 'json', index: true },

    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },

    // 无 default：未成功时该字段不应存在，而不是存在一个空壳对象
    result: { type: VlmResultSchema },
    rawText: { type: String, default: '' },
    modelCalls: { type: Number, default: 0 },
    modelId: { type: String, default: '' },
    elapsedMs: { type: Number, default: 0 },

    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'vlmTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
VlmTaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
VlmTaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
VlmTaskSchema.index({ userId: 1, createdAt: -1 });

const VlmTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<VlmTaskDocument>('VlmTask', VlmTaskSchema);

export default VlmTaskModel;
