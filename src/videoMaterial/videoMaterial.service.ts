import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { videoMaterialRepository } from './videoMaterial.repository.ts';
import { fileService } from '../file/file.service.ts';
import { fileRepository } from '../file/file.repository.ts';
import fileConfig from '../file/file.config.ts';
import type { FileDocument } from '../file/file.entity.ts';
import { buildMulterFile, nextUploadPath } from '../voiceTrainV2/voiceTrainV2Upload.helper.ts';
import type { VideoMaterialDocument } from './videoMaterial.entity.ts';
import type { UpdateVideoMaterialDto, VideoMaterialQueryDto } from './videoMaterial.dto.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { Types } from 'mongoose';
import { getCurrentUserId } from '../../utils/requestContext.ts';
import { videoMaterialGroupRepository } from '../videoMaterialGroup/videoMaterialGroup.repository.ts';
import { VIDEO_MATERIAL_CATEGORY } from '../../utils/constant/videoMaterial.ts';
import { SystemConstants } from '../../utils/constant/SystemConstants.ts';
import videoMaterialConfig from '../../utils/videoMaterial/videoMaterial.config.ts';
import { Logger } from '../../utils/Logger.ts';
import {
  createChunkSession,
  describeChunkSession,
  mergeChunkSession,
  pruneStaleChunkSessions,
  readChunkSession,
  removeChunkSession,
  resolveChunkInit,
} from './videoMaterialChunk.helper.ts';
import type { VideoMaterial } from '../../type/index.d.ts';

const logger = Logger.getInstance();

/** 平铺后的文件信息（files 记录字段 + 下载 URL） */
type FileInfo = Record<string, unknown> & { url: string };

/** 富化后的素材响应体（素材字段 + 关联文件信息 + 分组名称） */
type EnrichedMaterial = Record<string, unknown> & { file: FileInfo | null; groupName: string };

/** 业务结果：成功返回 data，失败返回 error + HTTP 状态码 */
type ServiceResult<T = EnrichedMaterial> = { data: T } | { error: string; code: number };

/** mongoose Document 或 lean 对象统一转成平铺 JSON 对象 */
function toPlain(doc: { toObject?: () => unknown }): Record<string, unknown> {
  return (typeof doc.toObject === 'function' ? doc.toObject() : doc) as unknown as Record<string, unknown>;
}

class VideoMaterialService {
  /** 构建文件下载 URL（与 mcp/fileDownload 一致） */
  private buildFileUrl(fileId: string): string {
    const serverUrl = SystemConstants.SERVER_URL.replace(/\/+$/, '');
    const prefix = process.env.NODE_ENV === 'development' ? '/dev' : '';
    return `${serverUrl}${prefix}/hip/api/files/${fileId}/download`;
  }

  /** 删除本次落盘文件（existsSync 守卫避免双删报错，仅清理文件服务未接管的临时文件） */
  private unlinkIfExists(filePath: string | undefined): void {
    if (!filePath) return;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // 清理失败忽略，避免覆盖原始错误
    }
  }

  /** 校验分组归属：groupId 非空时，必须是当前用户创建的未删除分组 */
  private async ensureGroupOwned(groupId: string): Promise<{ error: string; code: number } | null> {
    if (!Types.ObjectId.isValid(groupId)) {
      return { error: '非法的 groupId 参数', code: HttpStatus.BAD_REQUEST };
    }
    const owner = getCurrentUserId() ?? '';
    const group = await videoMaterialGroupRepository.findByIdAndCreateBy(groupId, owner);
    if (!group) {
      return { error: '分组不存在', code: HttpStatus.NOT_FOUND };
    }
    return null;
  }

  /** 批量解析 groupId → 分组名称（仅未删除分组；无分组/已失效的 ID 不在结果中，调用方回退 ''） */
  private async resolveGroupNames(groupIds: string[]): Promise<Map<string, string>> {
    const valid = [...new Set(groupIds.filter((id) => id && Types.ObjectId.isValid(id)))];
    if (valid.length === 0) return new Map();
    const groups = await videoMaterialGroupRepository.findByIds(valid);
    return new Map(groups.map((g) => [g._id.toString(), g.name]));
  }

  /** 单个素材富化：附带关联文件信息与下载 URL、分组名称 */
  private async enrich(mat: VideoMaterialDocument): Promise<EnrichedMaterial> {
    const [fileDoc, groupNames] = await Promise.all([
      fileService.getById(mat.fileId),
      this.resolveGroupNames([mat.groupId]),
    ]);
    return {
      ...toPlain(mat),
      groupName: groupNames.get(mat.groupId) ?? '',
      file: fileDoc ? { ...toPlain(fileDoc), url: this.buildFileUrl(fileDoc._id.toString()) } : null,
    };
  }

  /** 批量富化（findByIds 批量取文件与分组，避免 N+1） */
  private async enrichMany(mats: VideoMaterialDocument[]): Promise<EnrichedMaterial[]> {
    const [fileDocs, groupNames] = await Promise.all([
      fileRepository.findByIds(mats.map((m) => m.fileId)),
      this.resolveGroupNames(mats.map((m) => m.groupId)),
    ]);
    const fileMap = new Map(fileDocs.map((f) => [f._id.toString(), f]));
    return mats.map((mat) => {
      const fileDoc = fileMap.get(mat.fileId);
      return {
        ...toPlain(mat),
        groupName: groupNames.get(mat.groupId) ?? '',
        file: fileDoc ? { ...toPlain(fileDoc), url: this.buildFileUrl(fileDoc._id.toString()) } : null,
      };
    });
  }

  /** 分页列表（按 createBy 过滤：undefined=全部，''=公共素材，非空=指定用户） */
  private async listByCreateBy(createBy: string | undefined, query: VideoMaterialQueryDto) {
    const result = await videoMaterialRepository.findMany(createBy !== undefined ? { ...query, createBy } : query);
    return { ...result, list: await this.enrichMany(result.list) };
  }

  /** 全部素材分页列表 */
  async list(query: VideoMaterialQueryDto) {
    return this.listByCreateBy(undefined, query);
  }

  /** 按用户 id 查询用户自己的素材 */
  async listByUser(userId: string, query: VideoMaterialQueryDto) {
    return this.listByCreateBy(userId, query);
  }

  /** 公共素材列表（createBy 为空的第三方下载素材） */
  async listPublic(query: VideoMaterialQueryDto) {
    return this.listByCreateBy('', query);
  }

  /** 详情（不存在返回 null） */
  async getById(id: string): Promise<EnrichedMaterial | null> {
    const mat = await videoMaterialRepository.findById(id);
    if (!mat) return null;
    return this.enrich(mat);
  }

  /**
   * 创建（用户主动上传素材）：文件入库 + 建立 keyword → fileId 映射
   *
   * file 直接来自 multer 落盘（整份上传）；大文件请走分片口径（见 createFromChunk）。
   */
  async create(file: Express.Multer.File, keyword: string, fileName: string, groupId = ''): Promise<ServiceResult> {
    // 0. 分组归属校验（可选字段，非空时必须是当前用户的分组）：不通过则清理本次落盘文件
    if (groupId) {
      const groupError = await this.ensureGroupOwned(groupId);
      if (groupError) {
        this.unlinkIfExists(file.path);
        return groupError;
      }
    }

    // 1. keyword 判重（仅未删除记录）：已存在则不入库，并清理 multer 本次落盘文件
    if (await videoMaterialRepository.existsByKeyword(keyword)) {
      this.unlinkIfExists(file.path);
      return { error: '该关键字素材已存在', code: HttpStatus.CONFLICT };
    }

    // 2. 文件注册（category=material）
    const uploaded = await fileService.upload(file, { category: VIDEO_MATERIAL_CATEGORY, metadata: { keyword } });
    const fileId = uploaded.created._id.toString();

    // 3. 建映射记录（DB 异常向上抛，由 controller 统一处理）
    const created = await videoMaterialRepository.create({
      keyword,
      fileId,
      fileName: fileName || file.originalname,
      groupId,
    });
    return { data: await this.enrich(created) };
  }

  // ---- 大文件分片上传 ----
  // 会话只存磁盘（见 videoMaterialChunk.helper.ts），三个接口分别对应「建会话 / 传分片(由路由+中间件落盘) / 查进度·放弃」，
  // 全部到齐后调用 createFromChunk 合并入库。整份文件既不受 FILE_MAX_SIZE 约束，也能断点续传。

  /** 初始化分片上传会话：校验声明体量/分片数（resolveChunkInit）→ 建会话目录（顺带清理超期会话） */
  async initChunkUpload(
    dto: VideoMaterial.ChunkInitDto,
  ): Promise<{ data: VideoMaterial.ChunkSession } | { error: string; code: number }> {
    const resolved = resolveChunkInit(dto, crypto.randomUUID());
    if ('error' in resolved) {
      return { error: resolved.error, code: HttpStatus.BAD_REQUEST };
    }

    // 分片上传没有常驻调度器，趁机回收超期会话，避免放弃的上传永久占盘
    pruneStaleChunkSessions(fileConfig.uploadDir, videoMaterialConfig.sessionTtlMs, (message) =>
      logger.warn(`分片会话清理失败：${message}`),
    );

    await createChunkSession(fileConfig.uploadDir, resolved.data);
    return { data: describeChunkSession(fileConfig.uploadDir, resolved.data) };
  }

  /** 查询分片上传进度（断点续传：客户端据此只补传缺失分片） */
  async getChunkUpload(
    uploadId: string,
  ): Promise<{ data: VideoMaterial.ChunkSession } | { error: string; code: number }> {
    const meta = readChunkSession(fileConfig.uploadDir, uploadId);
    if (!meta) {
      return { error: '分片上传会话不存在或已过期', code: HttpStatus.NOT_FOUND };
    }
    return { data: describeChunkSession(fileConfig.uploadDir, meta) };
  }

  /** 放弃分片上传：删除会话目录与已收分片 */
  async abortChunkUpload(uploadId: string): Promise<{ data: true } | { error: string; code: number }> {
    const meta = readChunkSession(fileConfig.uploadDir, uploadId);
    if (!meta) {
      return { error: '分片上传会话不存在或已过期', code: HttpStatus.NOT_FOUND };
    }
    removeChunkSession(fileConfig.uploadDir, uploadId);
    return { data: true };
  }

  /**
   * 创建（分片口径）：合并会话全部分片 → 落 file 表 → 建 keyword 映射。
   *
   * 与 create(file, ...) 的差别只在「文件从哪来」，keyword 判重、file 记录、映射记录三步完全一致。
   */
  async createFromChunk(uploadId: string, keyword: string, fileName: string, groupId = ''): Promise<ServiceResult> {
    const meta = readChunkSession(fileConfig.uploadDir, uploadId);
    if (!meta) {
      return { error: '分片上传会话不存在或已过期', code: HttpStatus.NOT_FOUND };
    }

    // 分组归属校验（可选字段）：不通过则**保留会话**，客户端改正后可直接重试
    if (groupId) {
      const groupError = await this.ensureGroupOwned(groupId);
      if (groupError) {
        return groupError;
      }
    }

    // keyword 判重：冲突时**保留会话**，客户端改正 keyword 后可直接重试，不必重传整份文件
    if (await videoMaterialRepository.existsByKeyword(keyword)) {
      return { error: '该关键字素材已存在', code: HttpStatus.CONFLICT };
    }

    // 落盘路径与 uploadSingle 一致（uploads/Y/M/D/<uuid><ext>），使 fileService 的相对路径推导与静态访问无需特殊处理
    const destAbs = nextUploadPath(fileConfig.uploadDir, path.extname(meta.fileName).toLowerCase());

    try {
      await mergeChunkSession(fileConfig.uploadDir, uploadId, meta, destAbs);
    } catch (err) {
      // 缺片/字节数不符：会话与已收分片原样保留，客户端补齐后直接重试
      return { error: err instanceof Error ? err.message : '分片合并失败', code: HttpStatus.BAD_REQUEST };
    }

    // 合并成功，分片使命结束（此后磁盘上只剩合并后的成品）
    removeChunkSession(fileConfig.uploadDir, uploadId);

    let fileId: string;
    try {
      const uploaded = await fileService.upload(buildMulterFile(destAbs, meta.fileName, meta.mimeType), {
        category: VIDEO_MATERIAL_CATEGORY,
        metadata: { keyword },
      });
      fileId = uploaded.created._id.toString();
    } catch (err) {
      // 未建出 files 记录 → 清理磁盘上的合并产物，避免孤儿文件
      this.unlinkIfExists(destAbs);
      throw err;
    }

    // 3. 建映射记录（DB 异常向上抛，由 controller 统一处理；此时 files 记录已存在，磁盘文件保留）
    const created = await videoMaterialRepository.create({
      keyword,
      fileId,
      fileName: fileName || meta.fileName,
      groupId,
    });
    return { data: await this.enrich(created) };
  }

  /** 更新：带 file 则替换关联文件，否则仅更新元数据 */
  async update(id: string, file: Express.Multer.File | undefined, dto: UpdateVideoMaterialDto): Promise<ServiceResult> {
    const existing = await videoMaterialRepository.findById(id);
    if (!existing) {
      this.unlinkIfExists(file?.path);
      return { error: '素材不存在', code: HttpStatus.NOT_FOUND };
    }

    // keyword 变更时判重（排除自身，仅未删除记录）
    if (dto.keyword && dto.keyword !== existing.keyword) {
      if (await videoMaterialRepository.existsByKeywordExcluding(dto.keyword, id)) {
        this.unlinkIfExists(file?.path);
        return { error: '该关键字素材已存在', code: HttpStatus.CONFLICT };
      }
    }

    // 变更分组时校验归属（空串表示移出分组，直接允许）
    if (dto.groupId) {
      const groupError = await this.ensureGroupOwned(dto.groupId);
      if (groupError) {
        this.unlinkIfExists(file?.path);
        return groupError;
      }
    }

    // 重新上传：替换关联文件（旧文件记录保留）
    if (file) {
      const uploaded = await fileService.upload(file, {
        category: VIDEO_MATERIAL_CATEGORY,
        metadata: { keyword: dto.keyword ?? existing.keyword },
      });
      dto.fileId = uploaded.created._id.toString();
    }

    const updated = await videoMaterialRepository.updateById(id, dto as unknown as Record<string, unknown>);
    if (!updated) {
      return { error: '素材不存在', code: HttpStatus.NOT_FOUND };
    }
    return { data: await this.enrich(updated) };
  }

  /**
   * 批量分组：把当前用户的指定素材统一归入同一分组（groupId 空串表示移出分组）。
   *
   * 目标分组非空时须归属当前用户；素材侧以 createBy 收窄，非本人素材不会被改动。
   */
  async batchGroup(
    ids: string[],
    groupId: string,
  ): Promise<ServiceResult<{ modifiedCount: number }>> {
    if (groupId) {
      const groupError = await this.ensureGroupOwned(groupId);
      if (groupError) return groupError;
    }

    const owner = getCurrentUserId() ?? '';
    const modifiedCount = await videoMaterialRepository.updateGroupIdByIds(ids, groupId, owner);
    return { data: { modifiedCount } };
  }

  /** 删除（仅软删素材记录，文件记录与磁盘文件保留） */
  async delete(id: string): Promise<{ data: true } | { error: string; code: number }> {
    const ok = await videoMaterialRepository.softDeleteById(id);
    if (!ok) return { error: '素材不存在', code: HttpStatus.NOT_FOUND };
    return { data: true };
  }
}

export const videoMaterialService = new VideoMaterialService();
