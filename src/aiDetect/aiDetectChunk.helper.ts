// src/aiDetect/aiDetectChunk.helper.ts
//
// 场景切分源视频的分片上传会话：把通用的 utils/chunkUpload/chunkSession.ts 绑定到本域口径
// （目录 .aiDetectChunks / 合并后 2.5GB / 仅视频）。通用机制与设计取舍见该模块注释。
//
// 为什么这个入口需要分片：整份上传走 uploadDetectVideo，传输上限是 AI_DETECT_MAX_VIDEO_BYTES（200MB），
// 更大的片子只能分片 —— 先 init 建会话、逐片传，再带 uploadId 调 POST /scene/tasks 合并入库；
// 合并后的成品上限改由 aiDetectConfig.chunk.maxBytes 约束（与素材库同量级 2.5GB）。
import fileConfig from '../file/file.config.ts';
import aiDetectConfig from '../../utils/aiDetect/aiDetect.config.ts';
import { AI_DETECT_CHUNK_SUBDIR, aiDetectMimeFromName } from '../../utils/constant/aiDetect.ts';
import {
  createChunkSession,
  describeChunkSession,
  mergeChunkSession,
  pruneStaleChunkSessions,
  readChunkSession,
  removeChunkSession,
  resolveChunkInit,
} from '../../utils/chunkUpload/chunkSession.ts';
import type { ChunkUpload } from '../../type/index.d.ts';

/** 场景切分源视频的分片口径（体量上限/类型判定取自 aiDetectConfig 与场景切分常量表） */
export const AI_DETECT_CHUNK_PROFILE: ChunkUpload.Profile = {
  subdir: AI_DETECT_CHUNK_SUBDIR,
  noun: '视频',
  // 与整份上传共用源视频上限：两条通道口径一致，不会出现「整份能收、分片收不了」
  maxBytes: aiDetectConfig.maxVideoBytes,
  maxChunkBytes: aiDetectConfig.chunk.maxChunkBytes,
  maxChunks: aiDetectConfig.chunk.maxChunks,
  mimeFromName: aiDetectMimeFromName,
};

/** 校验并归一化 init 的声明（纯函数）：返回可直接落盘的会话元数据，或一句中文错误 */
export function resolveDetectChunkInit(
  dto: ChunkUpload.InitDto,
  uploadId: string,
): ReturnType<typeof resolveChunkInit> {
  return resolveChunkInit(dto, uploadId, AI_DETECT_CHUNK_PROFILE);
}

/** 读会话元数据；会话不存在、meta.json 损坏或字段不可信一律返回 null（调用方按「会话不存在」处理） */
export function readDetectChunkSession(uploadId: string): ChunkUpload.SessionMeta | null {
  return readChunkSession(fileConfig.uploadDir, uploadId, AI_DETECT_CHUNK_PROFILE);
}

/** 新建会话：建目录 + 写 meta.json（分片随后逐片落进同目录） */
export function createDetectChunkSession(meta: ChunkUpload.SessionMeta): Promise<void> {
  return createChunkSession(fileConfig.uploadDir, meta, AI_DETECT_CHUNK_PROFILE);
}

/** 组装对外会话视图（元数据 + 实时进度） */
export function describeDetectChunkSession(meta: ChunkUpload.SessionMeta): ChunkUpload.Session {
  return describeChunkSession(fileConfig.uploadDir, meta, AI_DETECT_CHUNK_PROFILE);
}

/** 顺序合并全部分片到 destAbs，返回合并后的字节数 */
export function mergeDetectChunkSession(
  uploadId: string,
  meta: ChunkUpload.SessionMeta,
  destAbs: string,
): Promise<number> {
  return mergeChunkSession(fileConfig.uploadDir, uploadId, meta, destAbs, AI_DETECT_CHUNK_PROFILE);
}

/** 删除整个会话目录（含全部已收分片）；不存在也算删除成功 */
export function removeDetectChunkSession(uploadId: string): void {
  removeChunkSession(fileConfig.uploadDir, uploadId, AI_DETECT_CHUNK_PROFILE);
}

/** 清理超期未完成的会话目录，返回清理数量 */
export function pruneDetectChunkSessions(
  ttlMs: number,
  onError?: (message: string) => void,
): number {
  return pruneStaleChunkSessions(fileConfig.uploadDir, ttlMs, AI_DETECT_CHUNK_PROFILE, onError);
}
