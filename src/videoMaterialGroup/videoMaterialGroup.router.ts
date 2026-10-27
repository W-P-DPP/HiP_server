import { Router } from 'express';
import {
  listVideoMaterialGroups,
  createVideoMaterialGroup,
  updateVideoMaterialGroup,
  deleteVideoMaterialGroup,
} from './videoMaterialGroup.controller.ts';

/**
 * 视频素材分组路由
 *
 * 挂在 src/index.ts 的 /videoMaterialGroups 下（JWT 之后）。
 * 分组按用户隔离（createBy 取请求上下文），新增素材时可选引用 groupId。
 */
const router = Router();

// ---- 查询 ----
router.get('/', listVideoMaterialGroups);

// ---- 管理 ----
router.post('/', createVideoMaterialGroup);
router.put('/:id', updateVideoMaterialGroup);
router.delete('/:id', deleteVideoMaterialGroup);

export default router;
