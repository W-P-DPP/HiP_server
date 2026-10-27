import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { videoMaterialService } from './videoMaterial.service.ts';
import type { BatchGroupVideoMaterialDto, UpdateVideoMaterialDto, VideoMaterialQueryDto } from './videoMaterial.dto.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import type { VideoMaterial } from '../../type/index.d.ts';

/**
 * 读整数：JSON 请求里是原生 number，字符串数字也一并收（客户端常沿用 multipart 的字符串习惯）。
 * 非法值返回 NaN，由 service 的 Number.isInteger 校验翻成 400。
 */
function readInteger(raw: unknown): number {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : Number.NaN;
  if (typeof raw === 'string' && raw.trim()) return Number.parseInt(raw, 10);
  return Number.NaN;
}

/** 解析公共查询参数：keyword / groupId / page / limit */
function buildMaterialQuery(req: Request): VideoMaterialQueryDto {
  const { keyword, groupId, page, limit } = req.query;
  return {
    ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
    // groupId 传空串表示筛选「未分组」，因此只要提供了字符串就带上
    ...(typeof groupId === 'string' ? { groupId } : {}),
    ...(page ? { page: parseInt(page as string, 10) } : {}),
    ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
  };
}

/** GET /api/videoMaterials */
export const listMaterials = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await videoMaterialService.list(buildMaterialQuery(req));
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/videoMaterials/my?userId=xxx —— 按用户 id 查询用户自己的素材 */
export const listMyMaterials = async (req: Request, res: Response): Promise<void> => {
  try {
    const uid =  req.jwtPayload?.id;
    if (!uid) {
      res.sendFail('缺少 userId 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    if (!Types.ObjectId.isValid(uid)) {
      res.sendFail('非法的 userId 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await videoMaterialService.listByUser(uid, buildMaterialQuery(req));
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/videoMaterials/public —— 公共素材列表（createBy 为空） */
export const listPublicMaterials = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await videoMaterialService.listPublic(buildMaterialQuery(req));
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/videoMaterials/:id */
export const getMaterialById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const material = await videoMaterialService.getById(id);
    if (!material) {
      res.sendFail('素材不存在', HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(material);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/videoMaterials
 * （multipart：file + keyword + fileName?；或 JSON：uploadId + keyword + fileName?，二者取其一）
 *
 * 整份上传走 file；**大文件走分片**——先按 chunks/init → chunks/:uploadId/:index 传完分片，
 * 再带 uploadId 调本接口，服务端此时才合并分片并建素材（合并失败/缺片返回 400，会话保留可续传）。
 */
export const createMaterial = async (req: Request, res: Response): Promise<void> => {
  try {
    const file = req.file;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';

    if (file && uploadId) {
      res.sendFail('不能同时上传文件与传入 uploadId，请二选一', HttpStatus.BAD_REQUEST);
      return;
    }
    if (!file && !uploadId) {
      res.sendFail('请上传文件（file）或传入分片会话 uploadId', HttpStatus.BAD_REQUEST);
      return;
    }

    const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
    if (!keyword) {
      res.sendFail('keyword 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
    const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';

    const result = file
      ? await videoMaterialService.create(file, keyword, fileName, groupId)
      : await videoMaterialService.createFromChunk(uploadId, keyword, fileName, groupId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '素材上传成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '上传失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/videoMaterials/chunks/init
 * （JSON：fileName + fileSize + totalChunks + chunkSize?）
 *
 * 建一条分片上传会话，返回 uploadId 与建议分片大小；随后按 uploadId 逐片上传。
 * 分片会话时长上限见 VIDEO_MATERIAL_CHUNK_SESSION_TTL_MS（超期会话在下次 init 时被回收）。
 */
export const initMaterialChunkUpload = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dto: VideoMaterial.ChunkInitDto = {
      fileName: typeof body.fileName === 'string' ? body.fileName.trim() : '',
      fileSize: readInteger(body.fileSize),
      totalChunks: readInteger(body.totalChunks),
      ...(body.chunkSize !== undefined ? { chunkSize: readInteger(body.chunkSize) } : {}),
    };

    const result = await videoMaterialService.initChunkUpload(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '分片上传会话已创建');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建分片上传会话失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/**
 * POST /api/videoMaterials/chunks/:uploadId/:index
 * （multipart：chunk 单片文件；index 为分片下标，从 0 开始）
 *
 * 落盘由 multer 完成（会话与下标已在路由中间件校验），这里只回报最新进度；
 * 断点续传时先 GET /chunks/:uploadId 拿已收下标，只补缺失的那几片。
 */
export const uploadMaterialChunk = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.sendFail('缺少分片文件（字段 chunk）', HttpStatus.BAD_REQUEST);
      return;
    }

    const uploadId = req.params.uploadId ?? '';
    const index = Number.parseInt(req.params.index ?? '', 10);

    const result = await videoMaterialService.getChunkUpload(uploadId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }

    const data: VideoMaterial.ChunkReceiveResult = { index, session: result.data };
    res.sendSuccess(data, '分片上传成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '分片上传失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/videoMaterials/chunks/:uploadId — 查询分片上传进度（已收下标，供断点续传） */
export const getMaterialChunkStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await videoMaterialService.getChunkUpload(req.params.uploadId ?? '');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询分片上传进度失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/videoMaterials/chunks/:uploadId — 放弃分片上传（删除会话目录与已收分片） */
export const abortMaterialChunkUpload = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await videoMaterialService.abortChunkUpload(req.params.uploadId ?? '');
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(null, '分片上传已取消');
  } catch (err) {
    const message = err instanceof Error ? err.message : '取消分片上传失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /api/videoMaterials/:id（multipart 可选：带 file 替换，否则仅更新元数据） */
export const updateMaterial = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto: UpdateVideoMaterialDto = {};
    if (typeof req.body.keyword === 'string' && req.body.keyword.trim()) {
      dto.keyword = req.body.keyword.trim();
    }
    if (typeof req.body.fileName === 'string') {
      dto.fileName = req.body.fileName.trim();
    }
    // groupId 传空串表示移出分组
    if (typeof req.body.groupId === 'string') {
      dto.groupId = req.body.groupId.trim();
    }

    const result = await videoMaterialService.update(id, req.file, dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, '素材更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /api/videoMaterials/batchGroup { ids: string[], groupId: string } —— 批量归入分组（groupId 空串=移出） */
export const batchGroupMaterials = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.sendFail('ids 为非空数组', HttpStatus.BAD_REQUEST);
      return;
    }
    if (ids.some((id) => typeof id !== 'string' || !Types.ObjectId.isValid(id))) {
      res.sendFail('ids 中包含非法 id', HttpStatus.BAD_REQUEST);
      return;
    }
    if (typeof body.groupId !== 'string') {
      res.sendFail('groupId 为必填字段（空串表示移出分组）', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto: BatchGroupVideoMaterialDto = { ids: ids as string[], groupId: body.groupId.trim() };
    const result = await videoMaterialService.batchGroup(dto.ids, dto.groupId);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.data, `成功更新 ${result.data.modifiedCount} 个素材的分组`);
  } catch (err) {
    const message = err instanceof Error ? err.message : '批量分组失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /api/videoMaterials/:id */
export const deleteMaterial = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await videoMaterialService.delete(id);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(null, '素材已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
