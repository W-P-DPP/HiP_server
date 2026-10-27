import type {
  SubtitleSourceMediaType,
  SubtitleSourceType,
  SubtitleTaskStatus,
} from './subtitleTask.entity.ts';

/** 创建字幕任务的入参（状态由仓库固定为 pending） */
export interface CreateSubtitleTaskData {
  sourceType: SubtitleSourceType;
  /** 源媒体类型，缺省 audio（老口径：直接上传音频） */
  sourceMediaType?: SubtitleSourceMediaType;
  audioFileId: string;
  audioUrl: string;
  originalName: string;
  language: string;
  /** 视频任务提交时提取出的临时音频相对路径；音频任务不传 */
  extractedAudioPath?: string;
  userId?: string;
}

/** 查询入参：userId 精确 + status 可选，分页 page/limit */
export interface QuerySubtitleTaskData {
  userId?: string;
  status?: SubtitleTaskStatus;
  page?: number;
  limit?: number;
}
