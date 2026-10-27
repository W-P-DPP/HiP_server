import { Router } from 'express';
import {
  listScheduledTasks,
  listRunRecords,
  getScheduledTaskById,
  createScheduledTask,
  updateScheduledTask,
  batchDeleteScheduledTasks,
  deleteScheduledTask,
} from './scheduledTask.controller.ts';

/**
 * 定时任务路由
 *
 * 权限：公开路由（本服务为内部可信服务，上游已验证用户身份，JWT_ENABLED=false）
 */
const router = Router();

// ---- 查询 ----
router.get('/', listScheduledTasks);
// 注意：/runs 必须在 /:id 之前注册，否则 Express 会把 'runs' 匹配到 :id
router.get('/runs', listRunRecords);
router.get('/:id', getScheduledTaskById);

// ---- 管理 ----
router.post('/', createScheduledTask);
router.put('/:id', updateScheduledTask);
// 注意：/batch 必须在 /:id 之前注册，否则 Express 会把 'batch' 匹配到 :id
router.delete('/batch', batchDeleteScheduledTasks);
router.delete('/:id', deleteScheduledTask);

export default router;
