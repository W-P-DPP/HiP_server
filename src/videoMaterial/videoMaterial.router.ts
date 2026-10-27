import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import multer from 'multer';
import {
  listMaterials,
  listMyMaterials,
  listPublicMaterials,
  getMaterialById,
  createMaterial,
  updateMaterial,
  batchGroupMaterials,
  deleteMaterial,
  initMaterialChunkUpload,
  uploadMaterialChunk,
  getMaterialChunkStatus,
  abortMaterialChunkUpload,
} from './videoMaterial.controller.ts';
import { uploadSingle, uploadMaterialChunk as uploadMaterialChunkFile } from '../../utils/middleware/uploadMiddleware.ts';
import { readChunkSession } from './videoMaterialChunk.helper.ts';
import fileConfig from '../file/file.config.ts';
import videoMaterialConfig from '../../utils/videoMaterial/videoMaterial.config.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/**
 * 视频素材库路由
 *
 * 挂在 src/index.ts 的 /videoMaterials 下（JWT 之后）。
 * POST 走 multipart：字段 file（单文件）+ keyword + fileName?；
 * 大文件改走分片：chunks/init → chunks/:uploadId/:index → 带 uploadId 调 POST /。
 */
const router = Router();

/**
 * 分片落盘前的校验：会话必须存在、下标必须落在 0..totalChunks-1。
 *
 * 放在 multer 之前，是因为 multer 的 diskStorage 会按 uploadId/index 拼路径写文件 ——
 * 校验晚一步就意味着非法入参已经落到磁盘上（还会为不存在的会话凭空建目录）。
 */
const validateMaterialChunk: RequestHandler = (req, res, next) => {
  const indexRaw = req.params.index ?? '';
  const meta = readChunkSession(fileConfig.uploadDir, req.params.uploadId ?? '');

  if (!meta) {
    res.sendFail('分片上传会话不存在或已过期', HttpStatus.NOT_FOUND);
    return;
  }
  if (!/^\d+$/.test(indexRaw)) {
    res.sendFail(`分片下标非法：须为 0..${meta.totalChunks - 1} 之间的整数`, HttpStatus.BAD_REQUEST);
    return;
  }

  const index = Number.parseInt(indexRaw, 10);
  if (index >= meta.totalChunks) {
    res.sendFail(`分片下标非法：须为 0..${meta.totalChunks - 1} 之间的整数`, HttpStatus.BAD_REQUEST);
    return;
  }
  next();
};

/**
 * 把 multer 的体积/字段错误翻成 400 业务提示。
 *
 * multer 抛出的错误默认会冒到全局 ErrorLogger 变成 500，而「单片超限」「字段名写错」都是
 * 用户输入问题，必须给出可读提示。其余错误原样交回 next，走既有错误链路。
 */
const handleMaterialChunkError: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = Math.round(videoMaterialConfig.maxChunkBytes / (1024 * 1024));
      res.sendFail(`单个分片不能超过 ${maxMb}MB`, HttpStatus.BAD_REQUEST);
      return;
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      res.sendFail('分片字段名应为 chunk', HttpStatus.BAD_REQUEST);
      return;
    }
  }
  next(err);
};

// ---- 查询 ----
router.get('/', listMaterials);
router.get('/my', listMyMaterials);
router.get('/public', listPublicMaterials);

// ---- 大文件分片上传（须注册在 /:id 之前，静态段优先）----
router.post('/chunks/init', initMaterialChunkUpload);
router.get('/chunks/:uploadId', getMaterialChunkStatus);
router.post('/chunks/:uploadId/:index', validateMaterialChunk, uploadMaterialChunkFile, handleMaterialChunkError, uploadMaterialChunk);
router.delete('/chunks/:uploadId', abortMaterialChunkUpload);

router.get('/:id', getMaterialById);

// ---- 管理 ----
router.post('/', uploadSingle, createMaterial);
// 批量分组：静态段须在 /:id 之前注册，否则 'batchGroup' 会被当成 :id
router.put('/batchGroup', batchGroupMaterials);
router.put('/:id', uploadSingle, updateMaterial);
router.delete('/:id', deleteMaterial);

export default router;
