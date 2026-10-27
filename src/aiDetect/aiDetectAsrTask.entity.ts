import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { AiDetectSourceType } from './aiDetectTask.entity.ts';

/** 任务状态：与另两类任务同一套五态（cancelled 仅排队中可取消） */
export type AiDetectAsrTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/** 一段识别出的文本（时间轴为**源视频全局毫秒**，已按块起点偏移过） */
export interface IAiDetectAsrSegment {
  /** 起点（ms，含） */
  startMs: number;
  /** 终点（ms，不含） */
  endMs: number;
  /** 识别文本 */
  text: string;
}

/** 一个音频块的处理记录（排障 + 复用凭据：wav 与子任务 id 都在这里） */
export interface IAiDetectAsrChunk {
  /** 块序号，从 1 开始 */
  index: number;
  /** 块在源视频时间轴上的区间起点（ms，含） */
  startMs: number;
  /** 区间终点（ms，不含） */
  endMs: number;
  /** 块音频在 file 表中的记录 id（转写链路只接受 fileId，故每块都必须登记） */
  wavFileId: string;
  /** 块音频下载地址，形如 /api/files/<id>/download */
  wavUrl: string;
  /** 该块对应的字幕子任务 id（排障用：可据此查字幕任务详情） */
  subtitleTaskId: string;
  /** 该块识别出的文本段数 */
  cueCount: number;
}

/** 单个场景的转写产物（自带区间，使本记录不依赖场景任务也能自解释） */
export interface IAiDetectAsrSceneSegments {
  /** 场景序号，对应源场景任务的 scenes[].index */
  index: number;
  /** 场景起点（ms，含） */
  startMs: number;
  /** 场景终点（ms，不含） */
  endMs: number;
  /** 归属本场景的文本段（可能为空数组：该场景没有说话） */
  segments: IAiDetectAsrSegment[];
}

/**
 * 场景转写任务。
 *
 * 一次任务 = 「解析来源场景任务与源视频 → 按固定时长切块抽音频 → 逐块走 subtitle 模块的
 * Whisper 链路转写 → 把分段文本按场景区间归并」，入参是**已完成的场景切分任务**（sourceTaskId）。
 *
 * 刻意与场景切分、场景抽帧分表分队列分额度：三者的输入、产物、成本模型都不同，
 * 混在一张表里会互相抢额度，还要靠类型字段区分。调度器仍是同一个进程、同一条 leader 租约。
 *
 * 转写**不在本进程内跑**：每块音频登记 file 表后提交给 subtitle 模块，由它的 leader 调度器
 * 与并发闸门（SUBTITLE_CONCURRENCY）实际执行 —— 本任务只做「切块 + 提交 + 轮询 + 归并」。
 */
export interface IAiDetectAsrTask extends IBaseMongoEntity {
  status: AiDetectAsrTaskStatus;

  /** 来源场景切分任务 id（必须是 success 且 scenes 非空） */
  sourceTaskId: string;

  /** 沿用来源场景任务的提交口径（排障用） */
  sourceType: AiDetectSourceType;
  /** 源视频 file 记录 id（自来源场景任务继承） */
  sourceFileId: string;
  /** 源视频下载地址，形如 /api/files/<id>/download */
  sourceUrl: string;
  /** 源视频原始文件名 */
  originalName: string;

  /** 场景数（自来源场景任务继承，= 归并时纳入的场景总数） */
  sceneCount: number;
  /** 源视频总时长（ms，自来源场景任务继承；切块按它规划） */
  durationMs: number;

  /** 执行期状态 */
  /**
   * 进度 0..1。
   * 真实百分比：逐块推进（0.05 解析源视频 → 0.1~0.9 逐块转写 → 1 完成），
   * 与抽帧同一口径，不是场景切分那种粗粒度四档。
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

  /** 音频块的处理记录（按块升序；success 后仍是排查「哪块出了什么问题」的唯一线索） */
  chunks: IAiDetectAsrChunk[];

  /** 结果 */
  /** 全局时间轴的文本段（扁平，时间已按块起点偏移） */
  segments: IAiDetectAsrSegment[];
  /** 同一批文本段按场景归组（每个场景一份，可能为空数组） */
  sceneSegments: IAiDetectAsrSceneSegments[];
  /** 文本段总数（= segments.length） */
  segmentCount: number;
  /** 实际生效的 ASR 通道（whisper / xunfei，取自字幕子任务；排障用） */
  provider: string;

  startedAt?: Date;
  finishedAt?: Date;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 场景转写任务 Mongoose Document 类型 */
export type AiDetectAsrTaskDocument = BaseDocument & IAiDetectAsrTask;

const AiDetectAsrSegmentSchema = new mongoose.Schema<IAiDetectAsrSegment>(
  {
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    text: { type: String, required: true },
  },
  // 文本段是内嵌值对象，没有独立身份
  { _id: false },
);

const AiDetectAsrSceneSegmentsSchema = new mongoose.Schema<IAiDetectAsrSceneSegments>(
  {
    index: { type: Number, required: true },
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    segments: { type: [AiDetectAsrSegmentSchema], default: [] },
  },
  { _id: false },
);

const AiDetectAsrChunkSchema = new mongoose.Schema<IAiDetectAsrChunk>(
  {
    index: { type: Number, required: true },
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    wavFileId: { type: String, required: true },
    wavUrl: { type: String, default: '' },
    subtitleTaskId: { type: String, default: '' },
    cueCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const AiDetectAsrTaskSchema = new mongoose.Schema<AiDetectAsrTaskDocument>(
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

    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },

    chunks: { type: [AiDetectAsrChunkSchema], default: [] },
    segments: { type: [AiDetectAsrSegmentSchema], default: [] },
    sceneSegments: { type: [AiDetectAsrSceneSegmentsSchema], default: [] },
    segmentCount: { type: Number, default: 0 },
    provider: { type: String, default: '' },

    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'aiDetectAsrTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
AiDetectAsrTaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
// （本表只有转写任务，故队列天然与场景切分、抽帧隔离）
AiDetectAsrTaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
AiDetectAsrTaskSchema.index({ userId: 1, createdAt: -1 });

// 转写提交守卫：同一场景任务是否已有排队/执行中的转写任务
AiDetectAsrTaskSchema.index({ sourceTaskId: 1, status: 1 });

const AiDetectAsrTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<AiDetectAsrTaskDocument>('AiDetectAsrTask', AiDetectAsrTaskSchema);

export default AiDetectAsrTaskModel;
