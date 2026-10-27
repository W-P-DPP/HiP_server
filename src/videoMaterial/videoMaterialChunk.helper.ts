// src/videoMaterial/videoMaterialChunk.helper.ts
//
// 素材库的分片上传会话：把通用的 utils/chunkUpload/chunkSession.ts 绑定到素材库口径
// （目录 .videoMaterialChunks / 合并后 2.5GB / 视频 + 图片）。
// 通用机制与设计取舍（为什么用「目录 + meta.json」而不是 Mongo 集合、完整性两道校验等）见该模块注释。
import videoMaterialConfig from '../../utils/videoMaterial/videoMaterial.config.ts';
import {
  VIDEO_MATERIAL_CHUNK_SUBDIR,
  videoMaterialMimeFromName,
} from '../../utils/constant/videoMaterial.ts';
import {
  chunkSessionDir as genericChunkSessionDir,
  chunkSessionRoot as genericChunkSessionRoot,
  createChunkSession as genericCreateChunkSession,
  describeChunkSession as genericDescribeChunkSession,
  listReceivedChunks as genericListReceivedChunks,
  mergeChunkSession as genericMergeChunkSession,
  pruneStaleChunkSessions as genericPruneStaleChunkSessions,
  readChunkSession as genericReadChunkSession,
  removeChunkSession as genericRemoveChunkSession,
  resolveChunkInit as genericResolveChunkInit,
} from '../../utils/chunkUpload/chunkSession.ts';
import type { ChunkUpload, VideoMaterial } from '../../type/index.d.ts';

/** 会话元数据（落盘形态） */
export type ChunkSessionMeta = ChunkUpload.SessionMeta;

/** 素材库的分片口径（体量上限/类型判定取自 videoMaterialConfig 与素材常量表） */
export const VIDEO_MATERIAL_CHUNK_PROFILE: ChunkUpload.Profile = {
  subdir: VIDEO_MATERIAL_CHUNK_SUBDIR,
  noun: '素材',
  maxBytes: videoMaterialConfig.maxBytes,
  maxChunkBytes: videoMaterialConfig.maxChunkBytes,
  maxChunks: videoMaterialConfig.maxChunks,
  mimeFromName: videoMaterialMimeFromName,
};

/** 分片会话根目录（uploads/.videoMaterialChunks） */
export function chunkSessionRoot(uploadDir: string): string {
  return genericChunkSessionRoot(uploadDir, VIDEO_MATERIAL_CHUNK_PROFILE);
}

/** 校验并归一化 init 的声明（纯函数）：返回可直接落盘的会话元数据，或一句中文错误 */
export function resolveChunkInit(
  dto: VideoMaterial.ChunkInitDto,
  uploadId: string,
): ReturnType<typeof genericResolveChunkInit> {
  return genericResolveChunkInit(dto, uploadId, VIDEO_MATERIAL_CHUNK_PROFILE);
}

/** 单个会话目录（只在 uploadId 合法时使用；调用前先过 isValidChunkUploadId） */
export function chunkSessionDir(uploadDir: string, uploadId: string): string {
  return genericChunkSessionDir(uploadDir, uploadId, VIDEO_MATERIAL_CHUNK_PROFILE);
}

/** 读会话元数据；会话不存在、meta.json 损坏或字段不可信一律返回 null */
export function readChunkSession(uploadDir: string, uploadId: string): ChunkSessionMeta | null {
  return genericReadChunkSession(uploadDir, uploadId, VIDEO_MATERIAL_CHUNK_PROFILE);
}

/** 新建会话：建目录 + 写 meta.json */
export async function createChunkSession(uploadDir: string, meta: ChunkSessionMeta): Promise<void> {
  await genericCreateChunkSession(uploadDir, meta, VIDEO_MATERIAL_CHUNK_PROFILE);
}

/** 删除整个会话目录（含全部已收分片）；不存在也算删除成功 */
export function removeChunkSession(uploadDir: string, uploadId: string): void {
  genericRemoveChunkSession(uploadDir, uploadId, VIDEO_MATERIAL_CHUNK_PROFILE);
}

/** 扫描已收到的分片下标（升序） */
export function listReceivedChunks(
  uploadDir: string,
  uploadId: string,
  totalChunks: number,
): number[] {
  return genericListReceivedChunks(uploadDir, uploadId, totalChunks, VIDEO_MATERIAL_CHUNK_PROFILE);
}

/** 组装对外会话视图（元数据 + 实时进度） */
export function describeChunkSession(
  uploadDir: string,
  meta: ChunkSessionMeta,
): ChunkUpload.Session {
  return genericDescribeChunkSession(uploadDir, meta, VIDEO_MATERIAL_CHUNK_PROFILE);
}

/** 顺序合并全部分片到 destAbs，返回合并后的字节数 */
export async function mergeChunkSession(
  uploadDir: string,
  uploadId: string,
  meta: ChunkSessionMeta,
  destAbs: string,
): Promise<number> {
  return genericMergeChunkSession(
    uploadDir,
    uploadId,
    meta,
    destAbs,
    VIDEO_MATERIAL_CHUNK_PROFILE,
  );
}

/** 清理超期未完成的会话目录，返回清理数量 */
export function pruneStaleChunkSessions(
  uploadDir: string,
  ttlMs: number,
  onError?: (message: string) => void,
): number {
  return genericPruneStaleChunkSessions(uploadDir, ttlMs, VIDEO_MATERIAL_CHUNK_PROFILE, onError);
}

export { isValidChunkUploadId } from '../../utils/chunkUpload/chunkSession.ts';
