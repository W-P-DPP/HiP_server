// utils/constant/videoMaterial.ts
/** 视频素材库（src/videoMaterial）业务常量 */
import path from 'node:path';

/** 上传素材在 file 表中的分类标识（与 utils/videoHelper/materialLibrary.ts 的第三方入库同分类） */
export const VIDEO_MATERIAL_CATEGORY = 'material';

/**
 * 分片会话在 uploads 下的点号子目录。
 *
 * 点号开头 + express.static 的 dotfiles 默认 ignore，故分片与半成品不会被 `/static/files` 暴露；
 * 与字幕提取音频的 `.subtitle` 同一策略。会话的文件命名形态（meta.json / <下标>.part / UUID 目录名）
 * 是与业务域无关的通用约定，见 utils/constant/chunkUpload.ts。
 */
export const VIDEO_MATERIAL_CHUNK_SUBDIR = '.videoMaterialChunks';

/**
 * 素材扩展名 → MIME。
 *
 * 分片是逐片到达的，单片请求带不上「整份文件」的 MIME，只能在 init 时按文件名扩展名定，
 * 故这里必须显式列出受支持的容器；**未知扩展名在 init 直接 400**，不给
 * `application/octet-stream` 兜底 —— 素材最终要被合成管道消费，入库一个 ffmpeg 认不出的
 * 文件不如当场拒绝。
 *
 * 含图片：素材库允许图片（见 utils/videoHelper/mediaKind.ts），图片同样可能很大。
 */
export const VIDEO_MATERIAL_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 从文件名推导素材 MIME；未知扩展名返回空串（调用方据此拒绝） */
export function videoMaterialMimeFromName(fileName: string): string {
  const ext = path.extname((fileName ?? '').trim()).toLowerCase();
  return VIDEO_MATERIAL_MIME_BY_EXT[ext] ?? '';
}

/** 视频素材库大文件分片上传常量 */
export class VideoMaterialConstants {
  /** 合并后素材大小上限（字节，2.5GB），不受全局 FILE_MAX_SIZE（50MB）约束 */
  public static readonly MAX_BYTES: number = 2.5 * 1024 * 1024 * 1024;

  /** 单个分片大小上限（字节），同时是分片路由 multer 的传输上限 */
  public static readonly MAX_CHUNK_BYTES: number = 16 * 1024 * 1024;

  /** 客户端未声明 chunkSize 时的建议分片大小（字节） */
  public static readonly CHUNK_BYTES: number = 8 * 1024 * 1024;

  /** 分片数上限，防止 totalChunks 被填成天文数字 */
  public static readonly MAX_CHUNKS: number = 10_000;

  /** 未完成分片会话的存活时长（ms），新建会话时清理超期目录 */
  public static readonly SESSION_TTL_MS: number = 24 * 60 * 60 * 1000;
}
