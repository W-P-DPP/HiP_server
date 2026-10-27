import express, { Router } from "express";
import { uploadSingle } from '../../utils/middleware/uploadMiddleware.ts';
import {
  addWxMaterial,
  uploadTempWxMaterial,
  delWxMaterial,
  getWxMaterial,
  batchGetWxMaterial,
  getWxMaterialCount,
  getWxMedia,
} from './wxMaterial.controller.ts';

const router: Router = express.Router();

// POST /api/wxMaterial — 新增永久素材（multipart：file + type + title/introduction）
router.post('/add', uploadSingle, addWxMaterial);
// POST /api/wxMaterial/tempUpload — 新增临时素材（multipart：file + type + title/introduction）
router.post('/tempUpload', uploadSingle, uploadTempWxMaterial);
// POST /api/wxMaterial/del — 删除永久素材（JSON：media_id）
router.post('/del', delWxMaterial);
// POST /api/wxMaterial/get — 获取永久素材详情（JSON：media_id）
router.post('/get', getWxMaterial);
// POST /api/wxMaterial/list — 获取永久素材列表（JSON：type、offset、count）
router.post('/list', batchGetWxMaterial);
// GET /api/wxMaterial/count — 获取永久素材数量
router.get('/count', getWxMaterialCount);
// POST /api/wxMaterial/getMedia — 获取临时素材（JSON：media_id）
router.post('/getMedia', getWxMedia);

export default router;
