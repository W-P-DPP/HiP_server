import type { Request, Response } from 'express';
import { fileService } from './file.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import type { FileQueryDto, UpdateFileDto, UploadOptions } from './file.dto.ts';

/** POST /api/files/upload — 单文件上传 */
export const uploadFile = async (req: Request, res: Response): Promise<void> => {
  const file = req.file;
  if (!file) {
    res.sendFail('请选择要上传的文件', HttpStatus.BAD_REQUEST);
    return;
  }

  const category = req.body.category as string | undefined;
  const createBy = req.body.createBy as string | undefined;
  let metadata: Record<string, unknown> | undefined;
  if (req.body.metadata) {
    try {
      metadata = typeof req.body.metadata === 'string'
        ? JSON.parse(req.body.metadata)
        : req.body.metadata;
    } catch {
      res.sendFail('metadata 格式不正确', HttpStatus.BAD_REQUEST);
      return;
    }
  }

  const options: UploadOptions = {};
  if (category) options.category = category;
  if (createBy) options.createBy = createBy;
  if (metadata) options.metadata = metadata;

  const result = await fileService.upload(file, options);
  res.sendSuccess(result.created, '文件上传成功');
};

/** POST /api/files/upload/multiple — 多文件上传 */
export const uploadMultipleFiles = async (req: Request, res: Response): Promise<void> => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    res.sendFail('请选择要上传的文件', HttpStatus.BAD_REQUEST);
    return;
  }

  const category = req.body.category as string | undefined;
  const createBy = req.body.createBy as string | undefined;
  let metadata: Record<string, unknown> | undefined;
  if (req.body.metadata) {
    try {
      metadata = typeof req.body.metadata === 'string'
        ? JSON.parse(req.body.metadata)
        : req.body.metadata;
    } catch {
      res.sendFail('metadata 格式不正确', HttpStatus.BAD_REQUEST);
      return;
    }
  }

  const options: UploadOptions = {};
  if (category) options.category = category;
  if (createBy) options.createBy = createBy;
  if (metadata) options.metadata = metadata;

  const result = await fileService.uploadMultiple(files, options);
  res.sendSuccess(result, '文件批量上传完成');
};

/** GET /api/files — 文件列表 */
export const listFiles = async (req: Request, res: Response): Promise<void> => {
  const { category, mimeType, keyword, page, limit } = req.query;

  const query: FileQueryDto = {
    ...(category && typeof category === 'string' ? { category } : {}),
    ...(mimeType && typeof mimeType === 'string' ? { mimeType } : {}),
    ...(keyword && typeof keyword === 'string' ? { keyword } : {}),
    ...(page ? { page: parseInt(page as string, 10) } : {}),
    ...(limit ? { limit: parseInt(limit as string, 10) } : {}),
  };

  const result = await fileService.list(query);
  res.sendSuccess(result);
};

/** GET /api/files/:id — 文件详情 */
export const getFileById = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const file = await fileService.getById(id!);
  if (!file) {
    res.sendFail('文件不存在', HttpStatus.NOT_FOUND);
    return;
  }
  res.sendSuccess(file);
};

/** GET /api/files/:id/download — 下载文件 */
export const downloadFile = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const file = await fileService.getById(id!);
  if (!file) {
    res.sendFail('文件不存在', HttpStatus.NOT_FOUND);
    return;
  }

  if (!fileService.fileExistsOnDisk(file)) {
    res.sendFail('文件在磁盘上不存在', HttpStatus.NOT_FOUND);
    return;
  }

  await fileService.recordDownload(id!);

  const absolutePath = fileService.getAbsolutePath(file);
  res.download(absolutePath, file.originalName);
};

/** PUT /api/files/:id — 更新文件元数据 */
export const updateFile = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const dto = req.body as UpdateFileDto;

  const result = await fileService.update(id!, dto);
  if ('error' in result) {
    res.sendFail(result.error, HttpStatus.NOT_FOUND);
    return;
  }
  res.sendSuccess(result.updated, '文件信息更新成功');
};

/** DELETE /api/files/:id — 删除文件 */
export const deleteFile = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const result = await fileService.delete(id!);
  if ('error' in result) {
    res.sendFail(result.error, HttpStatus.NOT_FOUND);
    return;
  }
  res.sendSuccess(null, '文件已删除');
};
