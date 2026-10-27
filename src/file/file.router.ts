import { Router } from 'express';
import {
  uploadFile,
  uploadMultipleFiles,
  listFiles,
  getFileById,
  downloadFile,
  updateFile,
  deleteFile,
} from './file.controller.ts';
import { uploadSingle, uploadMultiple } from '../../utils/middleware/uploadMiddleware.ts';

/**
 * 文件服务路由
 *
 * 权限：公开路由（本服务为内部可信服务，上游已验证用户身份）
 */
const router = Router();

// ---- 上传 ----
router.post('/upload', uploadSingle, uploadFile);
router.post('/upload/multiple', uploadMultiple, uploadMultipleFiles);

// ---- 查询 ----
router.get('/', listFiles);
router.get('/:id', getFileById);
router.get('/:id/download', downloadFile);

// ---- 管理 ----
router.put('/:id', updateFile);
router.delete('/:id', deleteFile);

export default router;
