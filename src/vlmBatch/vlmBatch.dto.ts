import type { Vlm, VlmBatch } from '../../type/index.d.ts';

/**
 * 单个识别项的建任务入参（提交时按来源抽帧任务展开后传入）。
 *
 * 只带「去哪儿取图」与「图上哪来的」—— 结果字段（status/result/message…）由仓储在 create 时
 * 统一置为 pending，执行期再逐项回写，故不在此声明。
 */
export interface VlmBatchItemInput {
  index: number;
  sceneIndex: number;
  frameKind: 'start' | 'mid' | 'end';
  timeMs: number;
  fileId: string;
  url: string;
}

/** 创建批量识别任务的入参（状态由仓库固定为 pending） */
export interface CreateVlmBatchTaskData {
  sourceType: VlmBatch.SourceType;
  /** 来源抽帧任务 id（提交时已校验为 success 且 frameCount 非空） */
  sourceTaskId: string;
  /** 源视频 file 记录 id（自来源抽帧任务继承，排障用） */
  sourceFileId: string;
  /** 源视频下载地址（自来源抽帧任务继承） */
  sourceUrl: string;
  /** 源视频原始文件名（自来源抽帧任务继承） */
  originalName: string;
  /** 实际下发的指令（归一后） */
  prompt: string;
  /** 输出形态（归一后） */
  mode: Vlm.Mode;
  /** 纳入的关键帧总数（= items.length） */
  total: number;
  /** 逐项展开好的识别项 */
  items: VlmBatchItemInput[];
  userId?: string;
}

/** 单项结果落库入参（dispatcher 在单项结算时写入） */
export interface CompleteVlmBatchItemData {
  status: VlmBatch.ItemStatus;
  /** 结构化结果；mode=text 或本项失败时不传（字段不应存在） */
  result?: Vlm.Result;
  rawText: string;
  message: string;
  modelCalls: number;
  modelId: string;
  elapsedMs: number;
}

/** 整批结果落库入参（dispatcher 在批次结算时写入） */
export interface CompleteVlmBatchTaskData {
  succeeded: number;
  failed: number;
  finishedAt: Date;
}

/** 查询入参：userId 精确 + status 可选，分页 page/limit */
export interface QueryVlmBatchTaskData {
  userId?: string;
  status?: VlmBatch.TaskStatus;
  page?: number;
  limit?: number;
}
