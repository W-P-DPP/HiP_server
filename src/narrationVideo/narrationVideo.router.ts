import express, { Router } from 'express';
import {
  cancelTask,
  getEngineStatus,
  getTask,
  getTaskQueuePosition,
  getTaskQueueStatus,
  listTasks,
  submitTask,
} from './narrationVideo.controller.ts';

const router: Router = express.Router();

// ---- 解说视频（解说结构化数据 → 源视频裁剪 + IndexTTS 配音 → 烧录字幕成片） ----
// 注意顺序：静态段 /tasks、/engine/status 必须注册在 /tasks/:taskId 之前。

// GET /api/narrationVideo/engine/status — 引擎状态（配音通道开关、队列深度、调度器状态）
router.get('/engine/status', getEngineStatus);

// POST /api/narrationVideo/tasks — 提交解说视频任务
//   （body：sceneTaskId/voiceId/narration 必填；speedMode 可选；userId 可选，回退 JWT）
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行；
//   （逐段 TTS 配音 → 源视频裁剪/拼接 → 画面适配解说 → 拼接 → 烧录字幕）。
router.post('/tasks', submitTask);

// GET /api/narrationVideo/tasks — 分页查询解说视频任务
//   （query：userId 精确可选，缺省回退当前登录用户；status 可选；page/limit）
router.get('/tasks', listTasks);

// GET /api/narrationVideo/tasks/queue/status — 解说视频任务队列计数（全局：总数 / 等待中 / 运行中）
//   静态三段路径，须注册在 /tasks/:taskId 之前，避免被通配段吞掉
router.get('/tasks/queue/status', getTaskQueueStatus);

// GET /api/narrationVideo/tasks/:taskId — 任务详情与进度
router.get('/tasks/:taskId', getTask);

// GET /api/narrationVideo/tasks/:taskId/queue — 排队位置
router.get('/tasks/:taskId/queue', getTaskQueuePosition);

// POST /api/narrationVideo/tasks/:taskId/cancel — 取消排队中的解说视频任务
router.post('/tasks/:taskId/cancel', cancelTask);

export default router;
