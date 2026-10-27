import express, { Router } from 'express';
import {
  cancelTask,
  getEngineStatus,
  getTask,
  getTaskQueuePosition,
  getTaskQueueStatus,
  listTasks,
  submitTask,
} from './vlmBatch.controller.ts';

const router: Router = express.Router();

// ---- 批量图像识别（基于场景抽帧关键帧，复用 Qwen3-VL 容器） ----
// 注意顺序：静态段 /engine/status、/tasks/queue/status 必须注册在 /tasks/:taskId 之前，
// 否则会被通配段吞掉（与 vlm.router.ts / aiDetect.router.ts 同一条约定）。

// GET /api/vlmBatch/engine/status — 引擎状态（开关、leader、队列深度、并发、容器可达性）
router.get('/engine/status', getEngineStatus);

// POST /api/vlmBatch/tasks — 提交批量识别任务
//   body：taskId（已完成的抽帧任务 id，必填）；mode/prompt 可选（整批共用）。
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步逐张提交给独立的 Qwen3-VL 容器执行。
router.post('/tasks', submitTask);

// GET /api/vlmBatch/tasks — 分页查询批量识别任务
router.get('/tasks', listTasks);

// GET /api/vlmBatch/tasks/queue/status — 队列计数（全局：总数 / 等待中 / 运行中）
//   静态三段路径，须注册在 /tasks/:taskId 之前，避免被通配段吞掉
router.get('/tasks/queue/status', getTaskQueueStatus);

// GET /api/vlmBatch/tasks/:taskId — 任务详情与进度（成功后含逐项结果 items）
router.get('/tasks/:taskId', getTask);

// GET /api/vlmBatch/tasks/:taskId/queue — 排队位置
router.get('/tasks/:taskId/queue', getTaskQueuePosition);

// POST /api/vlmBatch/tasks/:taskId/cancel — 取消排队中的任务（仅 pending）
router.post('/tasks/:taskId/cancel', cancelTask);

export default router;
