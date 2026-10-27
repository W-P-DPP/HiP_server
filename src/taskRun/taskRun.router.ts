import { Router } from 'express';
import {
  listTaskRuns,
  getTaskRunById,
  createTaskRun,
  updateTaskRun,
  deleteTaskRun,
} from './taskRun.controller.ts';

/**
 * 任务运行记录路由
 *
 * 权限：公开路由（本服务为内部可信服务，上游已验证用户身份，JWT_ENABLED=false）
 */
const router = Router();

// ---- 查询 ----
router.get('/', listTaskRuns);
router.get('/:id', getTaskRunById);

// ---- 管理 ----
router.post('/', createTaskRun);
router.put('/:id', updateTaskRun);
router.delete('/:id', deleteTaskRun);

export default router;
