import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { SceneDetect } from '../../type/index.d.ts';

/** 任务状态：pending 待领取 / running 执行中 / success 成功 / failed 失败 / cancelled 已取消 */
export type AiDetectTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/** 提交口径：upload 上传文件 / fileId 引用已有记录 / url 远程下载 */
export type AiDetectSourceType = 'upload' | 'fileId' | 'url';

/**
 * 单个场景区间（毫秒）。
 *
 * 与 SrtCue 一致用毫秒而非秒：前端时间轴、ffmpeg 的 -ss/-to 都按毫秒换算，避免浮点误差在边界累积。
 */
export interface IAiDetectScene {
  /** 序号，从 1 开始 */
  index: number;
  /** 场景起点（ms，含） */
  startMs: number;
  /** 场景终点（ms，不含） */
  endMs: number;
  /** 场景时长（ms） */
  durationMs: number;
}

/**
 * 首尾黑场被另立成的场景标记（见 src/aiDetect/aiDetectBlack.helper.ts）。
 *
 * 只记「哪一段、什么位置、是第几个场景」，不把 isBlack 塞进 IAiDetectScene —— 场景区间本身是
 * 检测引擎的产物，各下游都按它迭代，不该因为一次可选的黑场检测就多承担一层业务语义。
 */
export interface IAiDetectBlackSceneMark {
  /** 贴着头还是尾 */
  position: 'head' | 'tail';
  /** 该黑场现在是第几个场景（1 起，与 scenes[].index 对应） */
  sceneIndex: number;
  /** 黑场起点（ms，含） */
  startMs: number;
  /** 黑场终点（ms，不含） */
  endMs: number;
  /** 黑场时长（ms） */
  durationMs: number;
}

/**
 * 场景切分任务。
 *
 * 一次任务 = 「解析源视频 → PySceneDetect 检测 → （可选）首尾黑帧检测 → 落场景时间段」。
 * 提交接口只建 pending 记录并立即返回，真正执行的是「全机唯一」的 leader dispatcher
 * （见 aiDetectDispatcher.ts）。
 *
 * 「场景抽帧」是另一个任务、另一张表（aiDetectFrameTask.entity.ts）：「源视频 → 场景时间段」
 * 与「场景时间段 → 关键帧图片」的输入、产物、成本模型都不同，故各有各的集合、队列与并发额度。
 */
export interface IAiDetectTask extends IBaseMongoEntity {
  status: AiDetectTaskStatus;

  /** 提交口径（排障用） */
  sourceType: AiDetectSourceType;
  /** 源视频 file 记录 id（三种口径统一落到 file 记录） */
  sourceFileId: string;
  /** 源视频下载地址，形如 /api/files/<id>/download */
  sourceUrl: string;
  /** 源视频原始文件名 */
  originalName: string;
  /** sourceType=url 时调用方传入的原始地址；其余口径为空串 */
  remoteUrl: string;

  /** 检测参数（落库以便复现与重试；阈值等为 0 表示未指定，由脚本用推荐值） */
  detector: SceneDetect.Detector;
  threshold: number;
  minSceneLenSec: number;
  downscale: number;
  frameSkip: number;
  /** 首尾黑帧检测窗口时长（秒）；0 = 未做检测 */
  blackDetectSec: number;

  /** 执行期状态 */
  /** 进度 0..1（粗粒度四档，详见 aiDetectDispatcher） */
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
  /** 场景区间列表（仅 success 时非空） */
  scenes: IAiDetectScene[];
  /** 场景数（= scenes.length） */
  sceneCount: number;
  /** 源视频总时长（ms） */
  durationMs: number;
  /** 源视频帧率 */
  frameRate: number;
  /** 检测所用的 PySceneDetect 版本 */
  pySceneDetectVersion: string;
  /**
   * 首尾黑场被另立成的场景标记（仅 success 时可能有值）。
   * 空数组有两义，靠 blackDetectSec 区分：0 = 没做检测；>0 却为空 = 做了但没有首尾黑场。
   */
  blackRanges: IAiDetectBlackSceneMark[];

  startedAt?: Date;
  finishedAt?: Date;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 场景切分任务 Mongoose Document 类型 */
export type AiDetectTaskDocument = BaseDocument & IAiDetectTask;

const AiDetectSceneSchema = new mongoose.Schema<IAiDetectScene>(
  {
    index: { type: Number, required: true },
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    durationMs: { type: Number, required: true },
  },
  // 场景是任务的内嵌值对象，没有独立身份，不需要 _id
  { _id: false },
);

const AiDetectBlackSceneMarkSchema = new mongoose.Schema<IAiDetectBlackSceneMark>(
  {
    position: { type: String, enum: ['head', 'tail'], required: true },
    sceneIndex: { type: Number, required: true },
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    durationMs: { type: Number, required: true },
  },
  // 同样是值对象：标记的归属由它所在的场景任务文档决定
  { _id: false },
);

const AiDetectTaskSchema = new mongoose.Schema<AiDetectTaskDocument>(
  {
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    sourceType: {
      type: String,
      enum: ['upload', 'fileId', 'url'],
      default: 'fileId',
    },
    sourceFileId: { type: String, required: true, index: true },
    sourceUrl: { type: String, default: '' },
    originalName: { type: String, default: '' },
    remoteUrl: { type: String, default: '' },

    detector: { type: String, default: 'content' },
    threshold: { type: Number, default: 0 },
    minSceneLenSec: { type: Number, default: 0 },
    downscale: { type: Number, default: 0 },
    frameSkip: { type: Number, default: 0 },
    blackDetectSec: { type: Number, default: 0 },

    progress: { type: Number, default: 0 },
    stage: { type: String, default: 'pending' },
    message: { type: String, default: '' },
    workerId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },

    scenes: { type: [AiDetectSceneSchema], default: [] },
    sceneCount: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    frameRate: { type: Number, default: 0 },
    pySceneDetectVersion: { type: String, default: '' },
    blackRanges: { type: [AiDetectBlackSceneMarkSchema], default: [] },

    startedAt: { type: Date },
    finishedAt: { type: Date },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'aiDetectTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
AiDetectTaskSchema.plugin(BaseMongoPlugin);

// claimNextPending 的查询路径：按 status 过滤 + createdAt 升序取最老的一条
AiDetectTaskSchema.index({ status: 1, createdAt: 1 });

// 用户维度的任务列表查询
AiDetectTaskSchema.index({ userId: 1, createdAt: -1 });

const AiDetectTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<AiDetectTaskDocument>('AiDetectTask', AiDetectTaskSchema);

export default AiDetectTaskModel;
