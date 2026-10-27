// utils/chunkUpload/chunkSession.ts
//
// 大文件分片上传的会话管理（只在磁盘上，不落库）。
//
// 这里只放**与业务域无关**的会话机制，体量上限 / 目录名 / 类型判定与提示口径由调用方绑定的
// ChunkUpload.Profile 提供，避免每个业务域各抄一份（路径穿越防护、缺片校验这类逻辑抄第二份
// 就一定会分叉）：
//   - src/videoMaterial/videoMaterialChunk.helper.ts —— 素材库（视频/图片，2.5GB）
//   - src/aiDetect/aiDetectChunk.helper.ts          —— 场景切分的源视频（2.5GB）
//
// 为什么用「目录 + meta.json」而不是 Mongo 集合：
//   ① 分片本身就是磁盘文件，元数据与分片同目录才能整组创建/删除，不会留下孤立分片；
//   ② 磁盘对 cluster 的每个 worker 都是同一份，会话天然跨 worker 可见（内存 Map 不行）；
//   ③ 会话是一次性中间态，进数据库只会多一份需要清理的脏数据。
//
// 目录布局（与字幕临时音频同策略，点号子目录不被 express.static 暴露）：
//   uploads/<profile.subdir>/<uploadId>/meta.json
//   uploads/<profile.subdir>/<uploadId>/<下标>.part
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { CHUNK_ID_PATTERN, CHUNK_META_NAME, CHUNK_PART_PATTERN } from '../constant/chunkUpload.ts';
import type { ChunkUpload } from '../../type/index.d.ts';

/** 会话元数据（落盘形态） */
export type ChunkSessionMeta = ChunkUpload.SessionMeta;

/** 分片会话根目录（uploads/<profile.subdir>） */
export function chunkSessionRoot(uploadDir: string, profile: ChunkUpload.Profile): string {
  return path.join(uploadDir, profile.subdir);
}

/**
 * 校验并归一化 init 的声明（纯函数，可单测）：返回可直接落盘的会话元数据，或一句中文错误。
 *
 * 三条硬约束，缺一不可：
 *   ① 扩展名必须可识别 —— 分片口径下唯一的类型依据（单片请求带不上整份文件的 MIME）；
 *   ② 总体积不得超过 maxBytes、单片不得超过 maxChunkBytes —— 后者由「分片数」间接决定，
 *      分片给少了就等于超限，必须在这里算清楚；
 *   ③ 客户端声明的 chunkSize 必须与 fileSize/totalChunks 自洽 —— 双方切分口径不一致时，
 *      合并出来的文件会莫名缺几字节，那种错在合并之后极难定位，不如 init 就拒掉。
 */
export function resolveChunkInit(
  dto: ChunkUpload.InitDto,
  uploadId: string,
  profile: ChunkUpload.Profile,
): { data: ChunkSessionMeta } | { error: string } {
  const fileName = (dto.fileName ?? '').trim();
  if (!fileName) return { error: 'fileName 为必填字段' };

  const mimeType = profile.mimeFromName(fileName);
  if (!mimeType) {
    return { error: `不支持的${profile.noun}类型：${path.extname(fileName) || fileName}` };
  }

  const { fileSize, totalChunks, chunkSize: declaredChunkSize } = dto;
  if (!Number.isInteger(fileSize) || fileSize < 1) {
    return { error: 'fileSize 必须为正整数' };
  }
  if (fileSize > profile.maxBytes) {
    return { error: `${profile.noun}大小不能超过 ${Math.round(profile.maxBytes / (1024 * 1024))}MB` };
  }
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > profile.maxChunks) {
    return { error: `totalChunks 必须是 1..${profile.maxChunks} 之间的整数` };
  }

  const suggestedChunkSize = Math.ceil(fileSize / totalChunks);
  if (suggestedChunkSize > profile.maxChunkBytes) {
    const maxMb = Math.round(profile.maxChunkBytes / (1024 * 1024));
    return { error: `分片数过少：单个分片不能超过 ${maxMb}MB，请增大 totalChunks` };
  }

  if (declaredChunkSize !== undefined) {
    if (
      !Number.isInteger(declaredChunkSize) ||
      declaredChunkSize < 1 ||
      declaredChunkSize > profile.maxChunkBytes
    ) {
      return { error: `chunkSize 必须是 1..${profile.maxChunkBytes} 之间的整数` };
    }
    if (Math.ceil(fileSize / declaredChunkSize) !== totalChunks) {
      return { error: 'chunkSize 与 fileSize/totalChunks 不匹配：请按同一口径切分' };
    }
  }

  return {
    data: {
      uploadId,
      fileName,
      fileSize,
      mimeType,
      totalChunks,
      chunkSize: declaredChunkSize ?? suggestedChunkSize,
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * 会话 id 是否合法（目录名安全）。
 *
 * 会直接参与路径拼接，故必须严格按 UUID 形态校验；只查「不含分隔符」是不够的，
 * 严格白名单才是能一眼看懂的证明。
 */
export function isValidChunkUploadId(uploadId: string): boolean {
  return CHUNK_ID_PATTERN.test(uploadId ?? '');
}

/** 单个会话目录（只在 uploadId 合法时使用；调用前先过 isValidChunkUploadId） */
export function chunkSessionDir(
  uploadDir: string,
  uploadId: string,
  profile: ChunkUpload.Profile,
): string {
  return path.join(chunkSessionRoot(uploadDir, profile), uploadId);
}

/** 分片文件绝对路径 */
export function chunkPartPath(
  uploadDir: string,
  uploadId: string,
  index: number,
  profile: ChunkUpload.Profile,
): string {
  return path.join(chunkSessionDir(uploadDir, uploadId, profile), `${index}.part`);
}

/** 读会话元数据；会话不存在、meta.json 损坏或字段不可信一律返回 null（调用方按「会话不存在」处理） */
export function readChunkSession(
  uploadDir: string,
  uploadId: string,
  profile: ChunkUpload.Profile,
): ChunkSessionMeta | null {
  if (!isValidChunkUploadId(uploadId)) return null;

  try {
    const raw = fs.readFileSync(
      path.join(chunkSessionDir(uploadDir, uploadId, profile), CHUNK_META_NAME),
      'utf8',
    );
    const meta = JSON.parse(raw) as ChunkSessionMeta;
    if (!meta || typeof meta.fileName !== 'string' || !meta.fileName.trim()) return null;
    if (!Number.isInteger(meta.totalChunks) || meta.totalChunks < 1) return null;
    if (!Number.isInteger(meta.chunkSize) || meta.chunkSize < 1) return null;
    if (!Number.isFinite(meta.fileSize) || meta.fileSize < 1) return null;
    return meta;
  } catch {
    return null;
  }
}

/** 新建会话：建目录 + 写 meta.json（分片随后逐片落进同目录） */
export async function createChunkSession(
  uploadDir: string,
  meta: ChunkSessionMeta,
  profile: ChunkUpload.Profile,
): Promise<void> {
  const dir = chunkSessionDir(uploadDir, meta.uploadId, profile);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, CHUNK_META_NAME), JSON.stringify(meta), 'utf8');
}

/** 删除整个会话目录（含全部已收分片）；不存在也算删除成功 */
export function removeChunkSession(
  uploadDir: string,
  uploadId: string,
  profile: ChunkUpload.Profile,
): void {
  if (!isValidChunkUploadId(uploadId)) return;
  fs.rmSync(chunkSessionDir(uploadDir, uploadId, profile), { recursive: true, force: true });
}

/**
 * 扫描已收到的分片下标（升序）。
 *
 * 以**目录实际内容**为准而不是另记一份进度：客户端重传同一片（网络重试）只会覆盖同名文件，
 * 状态自动收敛，不需要幂等去重逻辑；越界下标的文件不认（防手改目录混入无关文件）。
 */
export function listReceivedChunks(
  uploadDir: string,
  uploadId: string,
  totalChunks: number,
  profile: ChunkUpload.Profile,
): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(chunkSessionDir(uploadDir, uploadId, profile));
  } catch {
    return [];
  }

  const indexes: number[] = [];
  for (const name of names) {
    const matched = CHUNK_PART_PATTERN.exec(name)?.[1];
    if (!matched) continue;
    const index = Number.parseInt(matched, 10);
    if (index >= 0 && index < totalChunks) indexes.push(index);
  }
  return indexes.sort((a, b) => a - b);
}

/** 组装对外会话视图（元数据 + 实时进度） */
export function describeChunkSession(
  uploadDir: string,
  meta: ChunkSessionMeta,
  profile: ChunkUpload.Profile,
): ChunkUpload.Session {
  const received = listReceivedChunks(uploadDir, meta.uploadId, meta.totalChunks, profile);
  return { ...meta, received, completed: received.length === meta.totalChunks };
}

/**
 * 顺序合并全部分片到 destAbs，返回合并后的字节数。
 *
 * 完整性两道校验，任一不满足就抛错（调用方翻成 400，会话保留供重传）：
 *   ① 每个下标都必须有 .part —— 少一片就合并必然产出坏文件；
 *   ② 实际字节数必须等于 init 时声明的 fileSize —— 抓客户端切分与声明不一致、上传被截断的情况。
 *
 * 失败时删掉半成品：宁可让客户端重传，也不留一个「看起来合并成功」的残缺文件给下游管道。
 */
export async function mergeChunkSession(
  uploadDir: string,
  uploadId: string,
  meta: ChunkSessionMeta,
  destAbs: string,
  profile: ChunkUpload.Profile,
): Promise<number> {
  const received = listReceivedChunks(uploadDir, uploadId, meta.totalChunks, profile);
  if (received.length !== meta.totalChunks) {
    throw new Error(`分片不完整：已收到 ${received.length}/${meta.totalChunks} 片，请续传缺失分片后再提交`);
  }

  await fsp.mkdir(path.dirname(destAbs), { recursive: true });
  const out = fs.createWriteStream(destAbs);
  let bytes = 0;

  try {
    for (let index = 0; index < meta.totalChunks; index += 1) {
      const part = chunkPartPath(uploadDir, uploadId, index, profile);
      const stat = await fsp.stat(part);
      bytes += stat.size;
      // end:false —— 后续分片还要往同一个写流里追加
      await pipeline(fs.createReadStream(part), out, { end: false });
    }
    out.end();
    await once(out, 'finish');
  } catch (err) {
    out.destroy();
    await fsp.rm(destAbs, { force: true }).catch(() => undefined);
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (bytes === 0) {
    await fsp.rm(destAbs, { force: true }).catch(() => undefined);
    throw new Error('合并后的文件为空');
  }
  if (bytes !== meta.fileSize) {
    await fsp.rm(destAbs, { force: true }).catch(() => undefined);
    throw new Error(`文件大小与声明不符：声明 ${meta.fileSize} 字节，实际 ${bytes} 字节`);
  }

  return bytes;
}

/**
 * 清理超期未完成的会话目录，返回清理数量。
 *
 * 以目录 mtime 计时（收到分片会刷新 mtime），故「长时间没动静」才会被回收，正在上传的会话不会被误删。
 * 尽力而为：单个目录删不掉只回调错误，不影响其它会话与当前上传。
 */
export function pruneStaleChunkSessions(
  uploadDir: string,
  ttlMs: number,
  profile: ChunkUpload.Profile,
  onError?: (message: string) => void,
): number {
  const root = chunkSessionRoot(uploadDir, profile);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }

  const deadline = Date.now() - Math.max(0, ttlMs);
  let removed = 0;
  for (const name of names) {
    if (!isValidChunkUploadId(name)) continue;
    try {
      const dir = path.join(root, name);
      const stat = fs.statSync(dir);
      if (!stat.isDirectory() || stat.mtimeMs >= deadline) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }
  return removed;
}
