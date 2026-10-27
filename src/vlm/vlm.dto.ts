import type { VlmMode, VlmSourceType, VlmTaskStatus } from './vlmTask.entity.ts';
import type { Vlm } from '../../type/index.d.ts';

/** 创建图片理解任务的入参（状态由仓库固定为 pending） */
export interface CreateVlmTaskData {
  sourceType: VlmSourceType;
  /** 源图片 file 记录 id */
  sourceFileId: string;
  /** 源图片下载地址 */
  sourceUrl: string;
  /** 源图片原始文件名 */
  originalName: string;
  /** 实际下发的指令（归一后） */
  prompt: string;
  /** 输出形态（归一后） */
  mode: VlmMode;
  userId?: string;
}

/** 理解结果落库入参（dispatcher 在任务成功时写入） */
export interface CompleteVlmTaskData {
  /** 结构化结果；mode=text 时不传（字段不应存在） */
  result?: Vlm.Result;
  /** 模型原始输出 */
  rawText: string;
  /** 容器侧实际调用模型的次数 */
  modelCalls: number;
  /** 容器侧实际使用的模型 id */
  modelId: string;
  /** 推理耗时（ms） */
  elapsedMs: number;
  finishedAt: Date;
}

/** 查询入参：userId 精确 + status 可选，分页 page/limit */
export interface QueryVlmTaskData {
  userId?: string;
  status?: VlmTaskStatus;
  page?: number;
  limit?: number;
}
