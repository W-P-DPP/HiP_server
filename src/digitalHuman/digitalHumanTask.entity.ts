import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { DigitalHuman } from '../../type/index.d.ts';

/** 数字人任务状态：pending 待领取 / running 执行中 / success 成功 / failed 失败 / cancelled 已取消 */
export type DigitalHumanTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/**
 * 数字人合成任务。
 *
 * 一条任务包含四个阶段：① 复用 IndexTTS 把文案合成配音（建一条 voiceTrainV2 合成任务并轮询）；
 * ② 可选：对配音音频跑字幕生成（复用 subtitle 模块，只依赖配音，故在对口型之前）；
 * ③ 把配音与形象参考视频交给 HeyGem 容器产出成片；④ 可选：把 SRT 烧录进成片
 * （burnSubtitles=true 时）。提交接口只建 pending 记录并立即返回，真正执行的是
 * 「全机唯一」的 leader dispatcher（见 digitalHumanDispatcher.ts）。
 */
export interface IDigitalHumanTask extends IBaseMongoEntity {
  status: DigitalHumanTaskStatus;

  /** 形象库记录 id（digitalHumanAvatars） */
  avatarId: string;
  /** 音色库记录 id（voiceTrainV2Voices） */
  voiceId: string;
  /** 驱动文案（入参快照） */
  text: string;
  /** 配音速度档位：fast / balanced / quality */
  speedMode: string;

  /** 执行期状态 */
  /**
   * 进度 0..1。未开启烧录：配音 0.05–0.30 / 数字人 0.30–0.97；
   * 开启烧录时数字人收缩到 0.45–0.85，让出 0.30–0.45 生成字幕、0.85–0.97 烧录。
   */
  progress: number;
  /** ASCII 阶段 key（见 utils/constant/digitalHuman.ts 的映射） */
  stage: string;
  /** 人类可读描述；失败原因也写这里 */
  message: string;
  /** 执行进程标识（排障用：哪个 cluster worker 跑的） */
  workerId: string;
  /** 被领取次数；>1 说明经历过中断重领 */
  attempts: number;

  /** 配音阶段：复用的 voiceTrainV2 合成任务 id */
  audioTaskId: string;
  /** 配音产物 file 记录 id */
  audioFileId: string;
  /** 配音产物下载地址 */
  audioUrl: string;
  /** 配音音频时长（秒） */
  audioDuration: number;

  /** 成片结果 */
  resultFileId: string;
  /** 成片下载地址，形如 /api/files/<id>/download */
  resultUrl: string;
  /** 成片时长（秒） */
  videoDuration: number;

  /** 字幕烧录：是否开启 */
  burnSubtitles: boolean;
  /** 烧录样式（仅存显式传入的字段，缺省由服务端默认值兜底） */
  subtitleOptions: DigitalHuman.SubtitleBurnOptions;
  /** 复用的字幕生成任务 id（中断重跑幂等，避免重复消耗 ASR） */
  subtitleTaskId: string;
  /** 烧录用字幕的 file 记录与条数 */
  srtFileId: string;
  srtUrl: string;
  cueCount: number;
  /** 烧录前的原始成片；仅开启烧录时非空 */
  rawVideoFileId: string;
  rawVideoUrl: string;

  startedAt?: Date;
  finishedAt?: Date;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 数字人任务 Mongoose Document 类型 */
export type DigitalHumanTaskDocument = BaseDocument & IDigitalHumanTask;

/** 烧录样式子文档：只保存调用方显式传入的字段（不在此写死默认值，便于后续改默认样式） */
const SubtitleOptionsSchema = new mongoose.Schema<DigitalHuman.SubtitleBurnOptions>(
  {
    fontSize: { type: Number },
    fontName: { type: String },
    colorHex: { type: String },
    outline: { type: Number },
    position: { type: String, enum: ['bottom', 'top'] },
    marginV: { type: Number },
  },
  { _id: false },
);

const DigitalHumanTaskSchema = new mongoose.Schema<DigitalHumanTaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    avatarId: { type: String, required: true, index: true },
    voiceId: { type: String, required: true, index: true },
    text: { type: String, required: true },
    speedMode: { type: String, default: 'balanced' },
    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    audioTaskId: { type: String, default: '' },
    audioFileId: { type: String, default: '' },
    audioUrl: { type: String, default: '' },
    audioDuration: { type: Number, default: 0 },
    resultFileId: { type: String, default: '' },
    resultUrl: { type: String, default: '' },
    videoDuration: { type: Number, default: 0 },
    burnSubtitles: { type: Boolean, default: false },
    subtitleOptions: { type: SubtitleOptionsSchema, default: () => ({}) },
    subtitleTaskId: { type: String, default: '' },
    srtFileId: { type: String, default: '' },
    srtUrl: { type: String, default: '' },
    cueCount: { type: Number, default: 0 },
    rawVideoFileId: { type: String, default: '' },
    rawVideoUrl: { type: String, default: '' },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'digitalHumanTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
DigitalHumanTaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
DigitalHumanTaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
DigitalHumanTaskSchema.index({ userId: 1, createdAt: -1 });

const DigitalHumanTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<DigitalHumanTaskDocument>('DigitalHumanTask', DigitalHumanTaskSchema);

export default DigitalHumanTaskModel;
