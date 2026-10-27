import type { VideoPipelineV2TaskMode, VideoPipelineV2TaskStatus } from './videoPipelineV2Task.entity.ts';

/** 创建管道任务时的入参（状态由仓库固定为 pending，基础字段由 schema 插件填充默认值） */
export interface CreateVideoPipelineV2TaskData {
  /** 音色库记录 id（voiceTrainV2Voices） */
  voiceId: string;
  /** 待合成文本 */
  text: string;
  /** 速度档位：fast / balanced / quality */
  speedMode: string;
  /** 背景色（色名或 #RRGGBB） */
  color?: string;
  /** 每个字幕段落对应的 Pixabay 素材搜索词 */
  keywords?: string[];
  userId?: string;
}

/** 创建「纯合成」任务时的入参：音频/字幕产物在建任务时即落库，调度器直接复用、不重跑配音与字幕 */
export interface CreateVideoComposeTaskData {
  /** 音频文件 id（files._id） */
  audioFileId: string;
  /** 音频下载地址 */
  audioUrl: string;
  /** 音频时长（秒） */
  audioDuration: number;
  /** 字幕 SRT 文件 id（files._id） */
  srtFileId: string;
  /** 字幕下载地址 */
  srtUrl: string;
  /** 字幕条数 */
  cueCount: number;
  /** 产物来源标记（compose 模式固定为 'compose'，表示未经 ASR） */
  provider: string;
  /** 背景色（色名或 #RRGGBB） */
  color?: string;
  /** 每个字幕段落对应的 Pixabay 素材搜索词 */
  keywords?: string[];
  /** 仅记录：音色库记录 id */
  voiceId?: string;
  /** 仅记录：待合成文本 */
  text?: string;
  /** 仅记录：速度档位 */
  speedMode: string;
  userId?: string;
}

/** 查询入参：userId 精确 + mode/status 可选，分页 page/limit */
export interface QueryVideoPipelineV2TaskData {
  userId?: string;
  mode?: VideoPipelineV2TaskMode;
  status?: VideoPipelineV2TaskStatus;
  page?: number;
  limit?: number;
}
