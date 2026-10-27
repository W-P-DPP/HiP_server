import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { AiDetectSourceType } from './aiDetectTask.entity.ts';

/** 任务状态：与场景切分同一套五态（cancelled 仅排队中可取消） */
export type AiDetectFrameTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/** 单场景抽取的三个帧位：开始帧 / 中间帧 / 结束帧 */
export type AiDetectFrameKind = 'start' | 'mid' | 'end';

/** 单张关键帧：帧位 + 实际抽帧时间点 + 登记进 file 表后的取用凭据 */
export interface IAiDetectFrame {
  /** 帧位 */
  kind: AiDetectFrameKind;
  /** 实际抽帧时间点（ms，保证落在该场景区间内） */
  timeMs: number;
  /** 帧图片在 file 表中的主键 */
  fileId: string;
  /** 帧图片下载地址，形如 /api/files/<id>/download */
  url: string;
}

/** 单个场景的抽帧产物（自带区间，使抽帧任务记录不依赖场景任务也能自解释） */
export interface IAiDetectSceneFrames {
  /** 场景序号，对应源场景任务的 scenes[].index */
  index: number;
  /** 场景起点（ms，含） */
  startMs: number;
  /** 场景终点（ms，不含） */
  endMs: number;
  /** 实际抽到的帧（1..3 张：极短场景的中间帧/结束帧会与开始帧重合而被去重） */
  frames: IAiDetectFrame[];
}

/**
 * 场景抽帧任务。
 *
 * 一次任务 = 「解析来源场景任务与源视频 → 按场景逐个抽 开始/中间/结束 三帧 → 登记 file 表」，
 * 入参是**已完成的场景切分任务**（sourceTaskId）。
 *
 * 刻意与场景切分分表（aiDetectTasks）、分队列、分并发额度：两者的输入（场景时间段 vs 源视频）、
 * 产物（帧图片 vs 场景时间段）、失败语义与成本模型都不同，混在一张表里会互相抢额度，还要靠
 * taskType 字段与历史兼容过滤来区分。调度器仍是同一个进程、同一条 leader 租约（见 aiDetectDispatcher）。
 */
export interface IAiDetectFrameTask extends IBaseMongoEntity {
  status: AiDetectFrameTaskStatus;

  /** 来源场景切分任务 id（必须是 success 且 scenes 非空） */
  sourceTaskId: string;

  /** 抽帧任务沿用来源场景任务的提交口径（排障用） */
  sourceType: AiDetectSourceType;
  /** 源视频 file 记录 id（自来源场景任务继承） */
  sourceFileId: string;
  /** 源视频下载地址，形如 /api/files/<id>/download */
  sourceUrl: string;
  /** 源视频原始文件名（同时是帧文件名的词干） */
  originalName: string;

  /** 场景数（自来源场景任务继承，= 抽帧时纳入的场景总数） */
  sceneCount: number;
  /** 源视频总时长（ms，自来源场景任务继承） */
  durationMs: number;
  /** 源视频帧率（自来源场景任务继承，用于换算结束帧的回退步长） */
  frameRate: number;

  /** 执行期状态 */
  /**
   * 进度 0..1。
   * 与场景切分的粗粒度四档不同，这里是**真实百分比**：抽帧是逐场景的重复子进程调用，
   * 每完成一个场景就能推进一次（0.05 解析源视频 → 0.1~0.9 抽帧中 → 1 完成）。
   */
  progress: number;
  /** ASCII 阶段 key（见 utils/constant/aiDetect.ts 的映射） */
  stage: string;
  /** 人类可读描述；失败原因也写这里 */
  message: string;
  /** 执行进程标识（排障用：哪个 cluster worker 跑的） */
  workerId: string;
  /** 被领取次数；>1 说明经历过中断重领 */
  attempts: number;

  /** 结果 */
  /** 每个场景的抽帧产物（仅 success 时非空，按场景序号升序） */
  frameScenes: IAiDetectSceneFrames[];
  /** 实际抽到的帧总数（= Σ frameScenes[].frames.length，≤ 3 × sceneCount） */
  frameCount: number;

  startedAt?: Date;
  finishedAt?: Date;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 场景抽帧任务 Mongoose Document 类型 */
export type AiDetectFrameTaskDocument = BaseDocument & IAiDetectFrameTask;

const AiDetectFrameSchema = new mongoose.Schema<IAiDetectFrame>(
  {
    kind: { type: String, enum: ['start', 'mid', 'end'], required: true },
    timeMs: { type: Number, required: true },
    fileId: { type: String, required: true },
    url: { type: String, default: '' },
  },
  // 帧是内嵌值对象：取用凭据是 fileId，自身不需要独立身份
  { _id: false },
);

const AiDetectSceneFramesSchema = new mongoose.Schema<IAiDetectSceneFrames>(
  {
    index: { type: Number, required: true },
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    frames: { type: [AiDetectFrameSchema], default: [] },
  },
  { _id: false },
);

const AiDetectFrameTaskSchema = new mongoose.Schema<AiDetectFrameTaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    sourceTaskId: { type: String, required: true, index: true },

    sourceType: {
      type: String,
      enum: ['upload', 'fileId', 'url'],
      default: 'fileId',
    },
    sourceFileId: { type: String, required: true, index: true },
    sourceUrl: { type: String, default: '' },
    originalName: { type: String, default: '' },

    sceneCount: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    frameRate: { type: Number, default: 0 },

    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },

    frameScenes: { type: [AiDetectSceneFramesSchema], default: [] },
    frameCount: { type: Number, default: 0 },

    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'aiDetectFrameTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
AiDetectFrameTaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
// （本表只有抽帧任务，故队列天然与场景切分隔离）
AiDetectFrameTaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
AiDetectFrameTaskSchema.index({ userId: 1, createdAt: -1 });

// 抽帧提交守卫：同一场景任务是否已有排队/执行中的抽帧任务
AiDetectFrameTaskSchema.index({ sourceTaskId: 1, status: 1 });

const AiDetectFrameTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<AiDetectFrameTaskDocument>('AiDetectFrameTask', AiDetectFrameTaskSchema);

export default AiDetectFrameTaskModel;
