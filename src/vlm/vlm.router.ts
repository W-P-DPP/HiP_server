import express, { Router, type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { uploadVlmImage } from '../../utils/middleware/uploadMiddleware.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import vlmConfig from '../../utils/vlm/vlm.config.ts';
import {
  cancelTask,
  getEngineStatus,
  getTask,
  getTaskQueuePosition,
  getTaskQueueStatus,
  listTasks,
  submitTask,
} from './vlm.controller.ts';

const router: Router = express.Router();

/**
 * 把 multer 的「超过体积上限」翻成 400 业务提示。
 *
 * multer 抛出的错误默认会冒到全局 ErrorLogger 变成 500，用户看到的是一句系统错误。
 * 其余错误原样交回 next，走既有错误链路（与 aiDetect.router.ts 同口径）。
 */
const handleVlmUploadError: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = Math.round(vlmConfig.maxImageBytes / (1024 * 1024));
    res.sendFail(`文件大小不能超过 ${maxMb}MB`, HttpStatus.BAD_REQUEST);
    return;
  }
  next(err);
};

// ---- 图片理解（Qwen3-VL） ----
// 注意顺序：静态段 /engine/status、/tasks/queue/status 必须注册在 /tasks/:taskId 之前，
// 否则会被通配段吞掉。

// GET /api/vlm/engine/status — 引擎状态（开关、leader、队列深度、并发、容器可达性）
router.get('/engine/status', getEngineStatus);

// POST /api/vlm/tasks — 提交图片理解任务
//   （multipart：file 图片；或表单：fileId 引用已有文件。二者取其一；mode/prompt 可选）
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步提交给独立的 Qwen3-VL 容器执行。
//   注意 uploadVlmImage 只解析 multipart：纯 JSON/表单的 fileId 口径会被它直接放行。
router.post('/tasks', uploadVlmImage, handleVlmUploadError, submitTask);

// GET /api/vlm/tasks — 分页查询理解任务
router.get('/tasks', listTasks);

// GET /api/vlm/tasks/queue/status — 队列计数（全局：总数 / 等待中 / 运行中）
//   静态三段路径，须注册在 /tasks/:taskId 之前，避免被通配段吞掉
router.get('/tasks/queue/status', getTaskQueueStatus);

// GET /api/vlm/tasks/:taskId — 任务详情与进度（成功后含 result）
router.get('/tasks/:taskId', getTask);

// GET /api/vlm/tasks/:taskId/queue — 排队位置
router.get('/tasks/:taskId/queue', getTaskQueuePosition);

// POST /api/vlm/tasks/:taskId/cancel — 取消排队中的任务（仅 pending）
router.post('/tasks/:taskId/cancel', cancelTask);

export default router;
