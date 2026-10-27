import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { Vlm, VlmBatch } from '../../type/index.d.ts';

/** 任务状态：与图片理解同一套五态（cancelled 仅排队中可取消） */
export type VlmBatchTaskStatus = VlmBatch.TaskStatus;

/** 单项状态：逐张关键帧各自的处理结果 */
export type VlmBatchItemStatus = VlmBatch.ItemStatus;

/**
 * 结构化理解结果（内嵌值对象）。
 *
 * 与 `vlmTask.entity.ts` 的 IVlmResult 同形 —— 两侧都经 `normalizeVlmResult` 收敛后才落库，
 * 故这里声明的是「收敛后」的形态。刻意在两张表里各自声明而不是共用一个 schema：
 * 两者分属不同的集合与模块，共用一个 schema 会把两个模块的迁移绑在一起（与仓库其它
 * 内嵌值对象各自声明同一取舍）。
 */
interface IVlmBatchItemResult {
  description: string;
  objects: string[];
  actions: string[];
  sceneType: string;
  tags: string[];
}

/** 单张关键帧的识别项（内嵌值对象，逐项可寻址） */
export interface IVlmBatchItem {
  /** 批次内的全局序号（从 0 起，与提交时按场景→帧位展开的顺序一致） */
  index: number;
  /** 所属场景序号（对应来源抽帧任务 frameScenes[].index） */
  sceneIndex: number;
  /** 帧位：开始 / 中间 / 结束 */
  frameKind: 'start' | 'mid' | 'end';
  /** 抽帧时间点（ms，落在该场景区间内） */
  timeMs: number;
  /** 帧图片在 file 表中的主键 */
  fileId: string;
  /** 帧图片下载地址，形如 /api/files/<id>/download */
  url: string;

  /** 本项处理状态 */
  status: VlmBatchItemStatus;
  /** 结构化结果（mode=json 且本项成功时存在） */
  result?: IVlmBatchItemResult;
  /** 模型原始输出（排障用；本项 JSON 不合契约时它是唯一线索） */
  rawText: string;
  /** 本项失败原因；成功时为空串 */
  message: string;
  /** 容器侧实际调用模型的次数（本项） */
  modelCalls: number;
  /** 容器侧实际使用的模型 id（本项） */
  modelId: string;
  /** 本项推理耗时（ms） */
  elapsedMs: number;
}

/**
 * 批量图像识别任务。
 *
 * 一次任务 = 「已完成的场景抽帧任务 → 对其**全部关键帧**逐张语义理解 → 逐项落回 items」，
 * 入参是**已完成的场景抽帧任务**（sourceTaskId），复用独立的 Qwen3-VL 容器（services/vlm）。
 *
 * 与单图任务（vlmTasks）分表、分队列、分并发额度：单图任务的语义是「一张图一条记录」，
 * 批次的语义是「一次提交 N 张、逐项可寻址」——混在一张表里既要靠类型字段区分，也会互相抢额度。
 * 分表后两条队列天然隔离（领取、并发、排队位次、中断恢复各算各的）。
 */
export interface IVlmBatchTask extends IBaseMongoEntity {
  status: VlmBatchTaskStatus;

  /** 提交口径：目前只支持 framesTask（已完成的抽帧任务） */
  sourceType: VlmBatch.SourceType;
  /** 来源场景抽帧任务 id（必须是 success 且 frameCount 非空） */
  sourceTaskId: string;
  /** 源视频 file 记录 id（自来源抽帧任务继承，排障用） */
  sourceFileId: string;
  /** 源视频下载地址，形如 /api/files/<id>/download */
  sourceUrl: string;
  /** 源视频原始文件名 */
  originalName: string;

  /** 整批实际下发的指令（缺省值已落库，便于复现同一批图的不同措辞效果） */
  prompt: string;
  /** 输出形态（整批共用） */
  mode: Vlm.Mode;

  /** 执行期状态 */
  /** 进度 0..1（按已完成项数推进） */
  progress: number;
  /** ASCII 阶段 key（见 utils/constant/vlmBatch.ts 的映射） */
  stage: string;
  /** 人类可读描述；整批失败原因也写这里 */
  message: string;
  /** 执行进程标识（排障用：哪个 cluster worker 跑的） */
  workerId: string;
  /** 被领取次数；>1 说明经历过中断重领 */
  attempts: number;

  /** 结果 */
  /** 纳入的关键帧总数（= items.length） */
  total: number;
  /** 识别成功项数 */
  succeeded: number;
  /** 识别失败项数 */
  failed: number;
  /** 逐项结果（提交时即展开为 pending，执行中逐项回写） */
  items: IVlmBatchItem[];

  startedAt?: Date;
  finishedAt?: Date;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 批量识别任务 Mongoose Document 类型 */
export type VlmBatchTaskDocument = BaseDocument & IVlmBatchTask;

const VlmBatchItemResultSchema = new mongoose.Schema<IVlmBatchItemResult>(
  {
    description: { type: String, required: true },
    objects: { type: [String], default: [] },
    actions: { type: [String], default: [] },
    sceneType: { type: String, default: 'other' },
    tags: { type: [String], default: [] },
  },
  // 结果是项的内嵌值对象，没有独立身份，不需要 _id
  { _id: false },
);

const VlmBatchItemSchema = new mongoose.Schema<IVlmBatchItem>(
  {
    index: { type: Number, required: true },
    sceneIndex: { type: Number, required: true },
    frameKind: { type: String, enum: ['start', 'mid', 'end'], required: true },
    timeMs: { type: Number, required: true },
    fileId: { type: String, required: true },
    url: { type: String, default: '' },

    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    // 无 default：未成功时该字段不应存在，而不是存在一个空壳对象
    result: { type: VlmBatchItemResultSchema },
    rawText: { type: String, default: '' },
    message: { type: String, default: '' },
    modelCalls: { type: Number, default: 0 },
    modelId: { type: String, default: '' },
    elapsedMs: { type: Number, default: 0 },
  },
  // 项是任务的内嵌值对象：取用凭据是 index / fileId，自身不需要独立身份
  { _id: false },
);

const VlmBatchTaskSchema = new mongoose.Schema<VlmBatchTaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },

    sourceType: { type: String, enum: ['framesTask'], default: 'framesTask' },
    sourceTaskId: { type: String, required: true, index: true },
    sourceFileId: { type: String, default: '' },
    sourceUrl: { type: String, default: '' },
    originalName: { type: String, default: '' },

    prompt: { type: String, default: '' },
    mode: { type: String, enum: ['json', 'text'], default: 'json', index: true },

    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },

    total: { type: Number, default: 0 },
    succeeded: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    items: { type: [VlmBatchItemSchema], default: [] },

    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'vlmBatchTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
VlmBatchTaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
// （本表只有批量识别任务，故队列天然与单图理解、抽帧隔离）
VlmBatchTaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
VlmBatchTaskSchema.index({ userId: 1, createdAt: -1 });

// 提交守卫：同一抽帧任务是否已有排队/执行中的批量识别任务
VlmBatchTaskSchema.index({ sourceTaskId: 1, status: 1 });

const VlmBatchTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<VlmBatchTaskDocument>('VlmBatchTask', VlmBatchTaskSchema);

export default VlmBatchTaskModel;
