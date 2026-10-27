import { Router } from 'express';
import {
  listSkills,
  getSkillByKey,
  createSkill,
  updateSkill,
  deleteSkill,
} from './skill.controller.ts';
import { uploadSkillFiles } from '../../utils/middleware/uploadMiddleware.ts';

/**
 * Skill 路由
 *
 * 权限：公开路由（本服务为内部可信服务，上游已验证用户身份，JWT_ENABLED=false）
 */
const router = Router();

// ---- 查询 ----
router.get('/', listSkills);
router.get('/:key', getSkillByKey);

// ---- 管理 ----
router.post('/', uploadSkillFiles, createSkill);
router.put('/:key', uploadSkillFiles, updateSkill);
router.delete('/:key', deleteSkill);

export default router;
