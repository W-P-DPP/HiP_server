// materialLibrary.ts — 本地素材库：第三方素材下载入库 + 相似度匹配复用
import fs from 'node:fs';
import path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { downloadVideo, searchVideo } from './pixabay.ts';
import { normalizeKeyword, sanitizeKeyword, similarityScore } from './similarity.ts';
import { fileService } from '../../src/file/file.service.ts';
import fileConfig from '../../src/file/file.config.ts';
import type { FileDocument } from '../../src/file/file.entity.ts';
import { videoMaterialRepository } from '../../src/videoMaterial/videoMaterial.repository.ts';
import type { VideoMaterialDocument } from '../../src/videoMaterial/videoMaterial.entity.ts';
import { runIsolatedContext } from '../requestContext.ts';
import { MaterialConstants } from '../constant/MaterialConstants.ts';

/** 素材库根目录（位于 uploads 下、.pipeline 之外，随管道清理保留） */
export function getMaterialsDir(): string {
    return path.join(fileConfig.uploadDir, 'materials');
}

/** 相似度匹配阈值（0~1，默认 0.6），取自 MaterialConstants */
export function getMatchThreshold(): number {
    return MaterialConstants.MATCH_THRESHOLD;
}

/**
 * 解析出的素材片段：绝对路径 + MIME。
 * MIME 必须随路径一起返回 —— 上游 background.ts 要据此区分图片/视频，图片得用 `-loop 1`
 * （见 mediaKind.ts），只给路径会在图片素材上误用 -stream_loop 把 ffmpeg 卡死。
 */
export interface ResolvedClip {
    path: string;
    mimeType: string;
}

/** 单池相似度扫描命中结果 */
interface ScanHit {
    mat: VideoMaterialDocument;
    fileDoc: FileDocument;
}

/** 相似度扫描单个候选池：stale 磁盘失配 → 软删继续；返回最高分命中（不足阈值 → null） */
async function scanPool(
    norm: string,
    threshold: number,
    materials: VideoMaterialDocument[],
): Promise<ScanHit | null> {
    let best: ScanHit | null = null;
    let bestScore = threshold;
    for (const mat of materials) {
        const score = similarityScore(norm, mat.keyword);
        if (score < bestScore) continue;

        let fileDoc: FileDocument | null = null;
        try {
            fileDoc = await fileService.getById(mat.fileId);
        } catch {
            fileDoc = null;
        }
        if (!fileDoc || !fileService.fileExistsOnDisk(fileDoc)) {
            await videoMaterialRepository.softDeleteById(mat._id.toString());
            continue;
        }
        bestScore = score;
        best = { mat, fileDoc };
    }
    return best;
}

/** in-flight 去重：归一化 keyword → 下载入库 Promise，压 mapLimit(3) 下同词并发重复下载 */
const inflight = new Map<string, Promise<ResolvedClip | null>>();

/**
 * 本地素材库匹配：keyword 归一化后与指定候选池的素材做相似度匹配，得分 ≥ 阈值取最高者。
 * createBy 传入时只扫描该归属池（'' 公共 / userId 个人），缺省则扫描全部（向后兼容）。
 * 磁盘文件失配（files 记录缺失或文件已被删）→ 软删该素材记录后继续扫描。
 * 命中 → 递增 hitCount 并返回素材（绝对路径 + MIME）；未命中 → null。
 */
export async function resolveLibraryMaterial(keyword: string, createBy?: string): Promise<ResolvedClip | null> {
    const norm = normalizeKeyword(keyword);
    if (!norm) return null;
    const threshold = getMatchThreshold();

    let materials: VideoMaterialDocument[];
    try {
        materials =
            createBy === undefined
                ? await videoMaterialRepository.findAll()
                : await videoMaterialRepository.findAllByCreateBy(createBy);
    } catch {
        return null;
    }

    const best = await scanPool(norm, threshold, materials);
    if (!best) return null;
    // 命中即计数（失败不影响返回）
    await videoMaterialRepository.incrementHitCount(best.mat._id.toString()).catch(() => {});
    return { path: fileService.getAbsolutePath(best.fileDoc), mimeType: best.fileDoc.mimeType };
}

/**
 * 第三方素材下载并入库：<materialsDir>/<sanitized>-<uuid>.mp4 + files 注册（category=material）
 * + videoMaterials 映射（keyword → fileId）。同词并发时仅一次真实下载。失败 → null。
 */
export async function saveLibraryMaterial(keyword: string, url: string): Promise<ResolvedClip | null> {
    const norm = normalizeKeyword(keyword);
    if (!norm) return null;
    const pending = inflight.get(norm);
    if (pending) return pending;

    // 第三方下载入库是“系统级”动作，素材应保持公共（createBy=''）：
    // 在无身份的独立 ALS 上下文中执行 doSave，避免管道后台任务继承发起请求的 userid，
    // 被基础插件 pre('save') 误填为个人素材（后台 AsyncQueue 会泄漏 HTTP 请求上下文）。
    const task = runIsolatedContext(() => doSave(keyword, url));
    inflight.set(norm, task);
    try {
        return await task;
    } finally {
        inflight.delete(norm);
    }
}

/** 实际下载入库（saveLibraryMaterial 去重后执行） */
async function doSave(keyword: string, url: string): Promise<ResolvedClip | null> {
    const dir = getMaterialsDir();
    fs.mkdirSync(dir, { recursive: true });
    // 磁盘文件按 keyword 命名 + 短 UUID 后缀：既按 keyword 可辨识，又保证 files.storedName 唯一
    // （files 集合对 storedName 建唯一索引，重名会在软删后重建时 E11000 冲突）。
    const base = sanitizeKeyword(keyword);
    const stored = `${base}-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}.mp4`;
    const dest = path.join(dir, stored);
    const tmp = `${dest}.tmp`;

    // 流式下载到 .tmp 再原子 rename，避免留下半截素材被后续匹配命中
    try {
        await downloadVideo(url, tmp);
        fs.renameSync(tmp, dest);
    } catch {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        return null;
    }

    const buf = fs.readFileSync(dest);
    const multerFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: `${base}.mp4`, // 对外下载名：干净的 keyword 名
        encoding: '7bit',
        mimetype: 'video/mp4',
        size: buf.length,
        destination: dir,
        filename: stored,
        path: dest,
        buffer: buf,
        stream: Readable.from(buf),
    };

    let fileId: string;
    let absolutePath: string;
    let fileName: string;
    let mimeType: string;
    try {
        const result = await fileService.upload(multerFile, { category: 'material', metadata: { keyword } });
        fileId = result.created._id.toString();
        absolutePath = fileService.getAbsolutePath(result.created);
        fileName = `${base}.mp4`;
        // Pixabay 下载恒为视频；以 files 记录的实际 MIME 为准（上传入参写的是 video/mp4）
        mimeType = result.created.mimeType;
    } catch {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return null;
    }

    try {
        await videoMaterialRepository.create({ keyword, fileId, fileName });
    } catch {
        // 入库失败仅跳过记录，不中断本次渲染（素材文件已在磁盘，下次匹配会重新下载）
    }
    return { path: absolutePath, mimeType };
}

/**
 * 按搜索词解析一个可用的本地素材片段，归属优先：
 * ① 当前用户自有素材（createBy = userId，传入 userId 时）→ ② 公共素材（createBy = ''）→
 * ③ 兜底从 Pixabay 搜索下载并入库（保持公共）。任何失败 → null（上层回退纯色背景，不抛错）。
 * 返回 ResolvedClip（路径 + MIME），供上层区分图片/视频的 ffmpeg 循环参数。
 */
export async function resolveClipForKeyword(keyword: string, userId?: string): Promise<ResolvedClip | null> {
    try {
        // 优先级 1：当前用户自有素材
        if (userId) {
            const own = await resolveLibraryMaterial(keyword, userId);
            if (own) return own;
        }
        // 优先级 2：公共素材
        const pub = await resolveLibraryMaterial(keyword, '');
        if (pub) return pub;
        // 兜底：Pixabay 下载入库
        const url = await searchVideo(keyword);
        if (!url) return null;
        return await saveLibraryMaterial(keyword, url);
    } catch {
        return null;
    }
}
