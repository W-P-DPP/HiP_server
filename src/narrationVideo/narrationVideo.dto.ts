import type { INarrationSegment, NarrationVideoTaskStatus } from './narrationVideoTask.entity.ts';

/** 创建解说视频任务的入参（状态由仓库固定为 pending，基础字段由 schema 插件填充默认值） */
export interface CreateNarrationVideoTaskData {
  /** 来源场景切分任务 id（提交时校验为 success） */
  sceneTaskId: string;
  /** 源视频 file 记录 id（自场景任务继承） */
  sourceFileId: string;
  /** 源视频下载地址（自场景任务继承） */
  sourceUrl: string;
  /** 源视频原始文件名（自场景任务继承） */
  sourceOriginalName: string;
  /** 源视频总时长（ms；可能为 0，执行期用 ffprobe 补齐） */
  sourceDurationMs: number;
  /** 解说标题 */
  title: string;
  /** 解说概要 */
  summary: string;
  /** 归一化后的解说分段 */
  segments: INarrationSegment[];
  /** 音色库记录 id */
  voiceId: string;
  /** 速度档位 */
  speedMode: string;
  userId?: string;
}

/** 查询入参：userId 精确 + status 可选，分页 page/limit */
export interface QueryNarrationVideoTaskData {
  userId?: string;
  status?: NarrationVideoTaskStatus;
  page?: number;
  limit?: number;
}
