import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 字幕任务状态：pending 待领取 / running 执行中 / success 成功 / failed 失败 / cancelled 已取消 */
export type SubtitleTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/** 提交口径：直接上传音频 / 引用已有 file 记录 */
export type SubtitleSourceType = 'upload' | 'fileId';

/** 源媒体类型：audio 直接上传音频（老路径）/ video 上传视频后提取音频 */
export type SubtitleSourceMediaType = 'audio' | 'video';

/**
 * 字幕生成任务。
 *
 * 一次任务 = 「解析源音频 → ASR 转写 → 落 SRT 到 file 表」。提交接口只建 pending 记录并
 * 立即返回，真正执行的是「全机唯一」的 leader dispatcher（见 subtitleDispatcher.ts）。
 */
export interface ISubtitleTask extends IBaseMongoEntity {
  status: SubtitleTaskStatus;

  /** 提交口径（排障用） */
  sourceType: SubtitleSourceType;
  /** 源媒体类型（audio/video），决定执行期要不要先提取音频 */
  sourceMediaType: SubtitleSourceMediaType;
  /**
   * 源媒体 file 记录 id。
   *
   * 音频任务=上传的音频；视频任务=上传的**视频**（提取出的音频不入 file 表，见 extractedAudioPath）。
   * 上传与 fileId 两种输入口径统一落到 file 记录。
   */
  audioFileId: string;
  /** 源媒体下载地址 */
  audioUrl: string;
  /** 源媒体原始文件名 */
  originalName: string;
  /** 识别语种 */
  language: string;
  /**
   * 视频任务提交时提取出的临时音频在 uploads 下的相对路径，形如 `.subtitle/<uuid>/audio.wav`。
   *
   * 音频任务恒为空串。属于中间产物：任务进入终态（成功/失败/取消）时删除；
   * 未删除（进程被杀）时由 dispatcher 复用，不会重复提取。
   */
  extractedAudioPath: string;

  /** 执行期状态 */
  /** 进度 0..1 */
  progress: number;
  /** ASCII 阶段 key（见 utils/constant/subtitle.ts 的映射） */
  stage: string;
  /** 人类可读描述；失败原因也写这里 */
  message: string;
  /** 执行进程标识（排障用：哪个 cluster worker 跑的） */
  workerId: string;
  /** 被领取次数；>1 说明经历过中断重领 */
  attempts: number;
  /** 实际生效的 ASR 通道：xunfei / whisper，成功前为空 */
  provider: string;

  /** 结果 */
  /** 生成的 SRT 在 file 表中的记录 id */
  srtFileId: string;
  /** SRT 下载地址，形如 /api/files/<id>/download */
  srtUrl: string;
  /** 字幕条数 */
  cueCount: number;
  /** 源音频时长（秒） */
  audioDuration: number;

  startedAt?: Date;
  finishedAt?: Date;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 字幕任务 Mongoose Document 类型 */
export type SubtitleTaskDocument = BaseDocument & ISubtitleTask;

const SubtitleTaskSchema = new mongoose.Schema<SubtitleTaskDocument>(
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
    // 老记录没有这个字段，读出来即默认 'audio'，行为与改造前一致
    sourceMediaType: {
      type: String,
      enum: ['audio', 'video'],
      default: 'audio',
    },
    audioFileId: { type: String, required: true, index: true },
    audioUrl: { type: String, default: '' },
    originalName: { type: String, default: '' },
    language: { type: String, default: '' },
    extractedAudioPath: { type: String, default: '' },
    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    provider: { type: String, default: '' },
    srtFileId: { type: String, default: '' },
    srtUrl: { type: String, default: '' },
    cueCount: { type: Number, default: 0 },
    audioDuration: { type: Number, default: 0 },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'subtitleTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
SubtitleTaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
SubtitleTaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
SubtitleTaskSchema.index({ userId: 1, createdAt: -1 });

const SubtitleTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<SubtitleTaskDocument>('SubtitleTask', SubtitleTaskSchema);

export default SubtitleTaskModel;
