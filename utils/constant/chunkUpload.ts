// utils/constant/chunkUpload.ts
/** 大文件分片上传（utils/chunkUpload/chunkSession.ts）通用常量：会话目录里的命名与形态 */

/** 会话元数据文件名（与分片同目录，便于整组清理） */
export const CHUNK_META_NAME = 'meta.json';

/**
 * 会话 id 形态：`crypto.randomUUID()` 产出的 UUID。
 *
 * 会话 id 直接用作目录名，必须严格校验 —— 否则 `../../` 之类的入参能把分片写到 uploads 之外。
 */
export const CHUNK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 分片文件名形态：`<下标>.part`（下标从 0 开始） */
export const CHUNK_PART_PATTERN = /^(\d+)\.part$/;
