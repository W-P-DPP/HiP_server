import type { Request, Response } from 'express';
import fs from 'node:fs';
import { wxMaterialService } from './wxMaterial.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import type { WxMediaType } from '../../utils/wx/wx.d.ts';
import type { AddMaterialDto, MediaIdParamsDto, BatchGetMaterialDto } from './wxMaterial.dto.ts';

// 素材类型：图片（image）、语音（voice）、视频（video）、缩略图（thumb）
const MEDIA_TYPES = ['image', 'voice', 'video', 'thumb'];
const isWxMediaType = (value: string): value is WxMediaType => MEDIA_TYPES.includes(value);

// 素材列表接口支持的 type（batchget_material 不支持 thumb，额外支持 news）
const LIST_MEDIA_TYPES = ['image', 'video', 'voice', 'news'] as const;
type ListMediaType = (typeof LIST_MEDIA_TYPES)[number];
const isListMediaType = (value: string): value is ListMediaType =>
  (LIST_MEDIA_TYPES as readonly string[]).includes(value);

/** 从 JWT 解析当前用户 id，缺失时返回 401 并返回 undefined */
function requireUserId(req: Request, res: Response): string | undefined {
  const userId = req.jwtPayload?.id as string | undefined;
  if (!userId) {
    res.sendFail('未登录或缺少用户身份', HttpStatus.UNAUTHORIZED);
    return undefined;
  }
  return userId;
}

/** POST /hip/wx/material — 新增永久素材（multipart：file + type + title/introduction） */
export const addWxMaterial = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const file = req.file;
  if (!file) {
    res.sendFail('请选择要上传的素材文件', HttpStatus.BAD_REQUEST);
    return;
  }
  // 校验失败或调用异常时清理 multer 临时文件（成功路径由 service 的 finally 清理）
  const cleanup = (): void => {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  };

  try {
    const body = req.body as Record<string, string | undefined>;
    const type = body.type;
    if (!type || !isWxMediaType(type)) {
      cleanup();
      res.sendFail('type 参数不合法，仅支持 image/voice/video/thumb', HttpStatus.BAD_REQUEST);
      return;
    }
    if (type === 'video' && (!body.title || !body.introduction)) {
      cleanup();
      res.sendFail('视频素材必须携带 title、introduction 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto: AddMaterialDto = { type, title: body.title, introduction: body.introduction };
    const result = await wxMaterialService.addMaterial(userId, file, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.ERROR);
      return;
    }
    res.sendSuccess(result.created, '素材上传成功');
  } catch (err) {
    cleanup();
    const message = err instanceof Error ? err.message : '素材上传失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /hip/wx/material/tempUpload — 新增临时素材（multipart：file + type + title/introduction） */
export const uploadTempWxMaterial = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const file = req.file;
  if (!file) {
    res.sendFail('请选择要上传的素材文件', HttpStatus.BAD_REQUEST);
    return;
  }
  const cleanup = (): void => {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  };

  try {
    const body = req.body as Record<string, string | undefined>;
    const type = body.type;
    if (!type || !isWxMediaType(type)) {
      cleanup();
      res.sendFail('type 参数不合法，仅支持 image/voice/video/thumb', HttpStatus.BAD_REQUEST);
      return;
    }
    if (type === 'video' && (!body.title || !body.introduction)) {
      cleanup();
      res.sendFail('视频素材必须携带 title、introduction 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto: AddMaterialDto = { type, title: body.title, introduction: body.introduction };
    const result = await wxMaterialService.uploadTempMedia(userId, file, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.ERROR);
      return;
    }
    res.sendSuccess(result.data, '临时素材上传成功');
  } catch (err) {
    cleanup();
    const message = err instanceof Error ? err.message : '临时素材上传失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /hip/wx/material/del — 删除永久素材 { media_id } */
export const delWxMaterial = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { media_id: mediaId } = req.body as MediaIdParamsDto;
    if (!mediaId) {
      res.sendFail('media_id 参数缺失', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await wxMaterialService.delMaterial(userId, mediaId);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.ERROR);
      return;
    }
    res.sendSuccess(result.data, '素材删除成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '素材删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /hip/wx/material/get — 获取永久素材详情 { media_id } */
export const getWxMaterial = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { media_id: mediaId } = req.body as MediaIdParamsDto;
    if (!mediaId) {
      res.sendFail('media_id 参数缺失', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await wxMaterialService.getMaterial(userId, mediaId);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.ERROR);
      return;
    }
    res.sendSuccess(result.data, '素材获取成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '素材获取失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /hip/wx/material/list — 获取永久素材列表 { type, offset, count } */
export const batchGetWxMaterial = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const body = req.body as Record<string, string | undefined>;
    const type = body.type;
    if (!type || !isListMediaType(type)) {
      res.sendFail('type 参数不合法，仅支持 image/video/voice/news', HttpStatus.BAD_REQUEST);
      return;
    }
    const offset = Number(body.offset ?? '0');
    const count = Number(body.count ?? '20');
    if (!Number.isInteger(offset) || offset < 0) {
      res.sendFail('offset 参数不合法，必须为非负整数', HttpStatus.BAD_REQUEST);
      return;
    }
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      res.sendFail('count 参数不合法，取值应在 1~20 之间', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto: BatchGetMaterialDto = { type, offset, count };
    const result = await wxMaterialService.batchGetMaterial(userId, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.ERROR);
      return;
    }
    res.sendSuccess(result.data, '素材列表获取成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '素材列表获取失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /hip/wx/material/count — 获取永久素材数量 */
export const getWxMaterialCount = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const result = await wxMaterialService.getMaterialCount(userId);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.ERROR);
      return;
    }
    res.sendSuccess(result.data, '素材数量获取成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '素材数量获取失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /hip/wx/material/getMedia — 获取临时素材 { media_id } */
export const getWxMedia = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { media_id: mediaId } = req.body as MediaIdParamsDto;
    if (!mediaId) {
      res.sendFail('media_id 参数缺失', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await wxMaterialService.getMedia(userId, mediaId);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.ERROR);
      return;
    }
    res.sendSuccess(result.data, '临时素材获取成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '临时素材获取失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
