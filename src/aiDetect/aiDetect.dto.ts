import type {
  AiDetectSourceType,
  AiDetectTaskStatus,
  IAiDetectBlackSceneMark,
  IAiDetectScene,
} from './aiDetectTask.entity.ts';
import type {
  AiDetectFrameTaskStatus,
  IAiDetectSceneFrames,
} from './aiDetectFrameTask.entity.ts';
import type {
  AiDetectAsrTaskStatus,
  IAiDetectAsrSceneSegments,
  IAiDetectAsrSegment,
} from './aiDetectAsrTask.entity.ts';
import type { SceneDetect } from '../../type/index.d.ts';

/** 创建场景切分任务的入参（状态由仓库固定为 pending） */
export interface CreateAiDetectTaskData {
  sourceType: AiDetectSourceType;
  /** 源视频 file 记录 id */
  sourceFileId: string;
  /** 源视频下载地址 */
  sourceUrl: string;
  /** 源视频原始文件名 */
  originalName: string;
  /** sourceType=url 时的原始地址；其余口径不传 */
  remoteUrl?: string;
  /** 检测算法（已归一化） */
  detector: SceneDetect.Detector;
  /** 检测阈值；0 = 未指定 */
  threshold: number;
  /** 最短场景时长（秒）；0 = 未指定 */
  minSceneLenSec: number;
  /** 降采样倍数；0 = 未指定 */
  downscale: number;
  /** 隔帧采样数；0 = 逐帧 */
  frameSkip: number;
  /** 首尾黑帧检测窗口时长（秒）；0 = 未指定（不做检测） */
  blackDetectSec: number;
  userId?: string;
}

/** 检测结果落库入参（dispatcher 在任务成功时写入） */
export interface CompleteAiDetectTaskData {
  scenes: IAiDetectScene[];
  sceneCount: number;
  durationMs: number;
  frameRate: number;
  pySceneDetectVersion: string;
  /** 首尾黑场标记（未做黑帧检测或首尾无黑场时为空数组） */
  blackRanges: IAiDetectBlackSceneMark[];
  finishedAt: Date;
}

/**
 * 创建抽帧任务的入参。
 *
 * 与 CreateAiDetectTaskData 分开而不是做成一个多态 DTO：抽帧不接源视频（源视频由场景任务决定）、
 * 也不用任何检测参数，硬塞进同一个接口会让每个字段都要额外解释「哪类任务才用得上」。
 * 源视频与场景相关信息在建任务时从场景任务继承，故这里要求调用方传入。
 */
export interface CreateFrameTaskData {
  /** 来源场景切分任务 id（提交时已校验为 success 且 scenes 非空） */
  sourceTaskId: string;
  /** 源视频 file 记录 id（自场景任务继承） */
  sourceFileId: string;
  /** 源视频下载地址（自场景任务继承） */
  sourceUrl: string;
  /** 源视频原始文件名（自场景任务继承，同时是帧文件名的词干） */
  originalName: string;
  /** 场景数（自场景任务继承） */
  sceneCount: number;
  /** 源视频总时长（ms，自场景任务继承） */
  durationMs: number;
  /** 源视频帧率（自场景任务继承，用于换算结束帧的回退步长） */
  frameRate: number;
  /** 抽帧任务沿用来源任务的提交口径（排障用） */
  sourceType: AiDetectSourceType;
  userId?: string;
}

/** 抽帧结果落库入参（dispatcher 在任务成功时写入） */
export interface CompleteFrameTaskData {
  frameScenes: IAiDetectSceneFrames[];
  frameCount: number;
  finishedAt: Date;
}

/**
 * 创建转写任务的入参。
 *
 * 与另两个 CreateXxx 分开的理由同前：转写不接源视频上传、也不带检测参数，
 * 源视频与场景信息一律从来源场景任务继承（由 service 在提交时读出并填入）。
 */
export interface CreateAsrTaskData {
  /** 来源场景切分任务 id（提交时已校验为 success 且 scenes 非空） */
  sourceTaskId: string;
  /** 源视频 file 记录 id（自来源场景任务继承） */
  sourceFileId: string;
  /** 源视频下载地址（自来源场景任务继承） */
  sourceUrl: string;
  /** 源视频原始文件名（自来源场景任务继承） */
  originalName: string;
  /** 场景数（自来源场景任务继承） */
  sceneCount: number;
  /** 源视频总时长（ms，自来源场景任务继承；切块按它规划） */
  durationMs: number;
  /** 沿用来源任务的提交口径（排障用） */
  sourceType: AiDetectSourceType;
  userId?: string;
}

/** 转写结果落库入参（dispatcher 在任务成功时写入） */
export interface CompleteAsrTaskData {
  segments: IAiDetectAsrSegment[];
  sceneSegments: IAiDetectAsrSceneSegments[];
  segmentCount: number;
  provider: string;
  finishedAt: Date;
}

/**
 * 查询场景切分任务的入参：userId 精确 + status 可选，分页 page/limit。
 * （抽帧任务在自己的表里，见 QueryAiDetectFrameTaskData，两者不再靠字段区分）
 */
export interface QueryAiDetectTaskData {
  userId?: string;
  status?: AiDetectTaskStatus;
  page?: number;
  limit?: number;
}

/** 查询抽帧任务的入参：口径与 QueryAiDetectTaskData 一致，只是另一张表 */
export interface QueryAiDetectFrameTaskData {
  userId?: string;
  status?: AiDetectFrameTaskStatus;
  page?: number;
  limit?: number;
}

/** 查询转写任务的入参：口径与另两个一致，只是另一张表 */
export interface QueryAiDetectAsrTaskData {
  userId?: string;
  status?: AiDetectAsrTaskStatus;
  page?: number;
  limit?: number;
}
