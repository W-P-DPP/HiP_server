import express, { Router } from 'express';
import {
  cancelTask,
  getEngineStatus,
  getTask,
  getTaskQueuePosition,
  getTaskQueueStatus,
  listTasks,
  submitComposeTask,
  submitTask,
} from './videoPipelineV2.controller.ts';

const router: Router = express.Router();

// ---- 视频生成管道 V2（本地 IndexTTS 配音 + Whisper 字幕 → ffmpeg 烧录） ----
// 注意顺序：静态段 /tasks、/engine/status 必须注册在 /tasks/:taskId 之前。

// GET /api/videoPipelineV2/engine/status — 管道引擎状态（两段通道开关、队列深度、本地 Whisper 可达性）
router.get('/engine/status', getEngineStatus);

// POST /api/videoPipelineV2/tasks — 提交视频生成任务
//   （body：voiceId/text 必填；speedMode 可选，缺省 balanced；color/keywords 可选；userId 可选，回退 JWT）
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行
//   （IndexTTS 配音 → Whisper 字幕 → [背景轨] → 烧录合成 → 落库）。
router.post('/tasks', submitTask);

// POST /api/videoPipelineV2/tasks/compose — 提交「纯合成」任务
//   （body：audioFileId/srtFileId 必填；keywords/color 可选；voiceId/text/speedMode 仅随任务记录）
//   跳过配音与字幕，直接用已知音频 + 字幕构建背景轨并烧录成片；返回 taskId，轮询 GET /tasks/:taskId。
router.post('/tasks/compose', submitComposeTask);

// GET /api/videoPipelineV2/tasks — 分页查询管道任务
//   （query：userId 精确可选，缺省回退当前登录用户；status 可选；page/limit）
router.get('/tasks', listTasks);

// GET /api/videoPipelineV2/tasks/queue/status — 视频合成任务队列计数（全局：总数 / 等待中 / 运行中）
//   静态三段路径，须注册在 /tasks/:taskId 之前，避免被通配段吞掉
router.get('/tasks/queue/status', getTaskQueueStatus);

// GET /api/videoPipelineV2/tasks/:taskId — 任务详情与进度
//   （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
router.get('/tasks/:taskId', getTask);

// GET /api/videoPipelineV2/tasks/:taskId/queue — 排队位置
//   （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
router.get('/tasks/:taskId/queue', getTaskQueuePosition);

// POST /api/videoPipelineV2/tasks/:taskId/cancel — 取消排队中的视频合成任务
//   （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
//   仅 pending 可取消：走仓储对 status=pending 的原子条件更新，与 dispatcher 的领取互斥，
//   取消成功后不会再被执行；已在运行/已终结的任务返回 409。
router.post('/tasks/:taskId/cancel', cancelTask);

export default router;
