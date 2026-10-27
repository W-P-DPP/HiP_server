import express, { Router } from 'express';
import { uploadSingle } from '../../utils/middleware/uploadMiddleware.ts';
import {
  cancelTask,
  createAvatar,
  deleteAvatar,
  getAvatar,
  getEngineStatus,
  getTask,
  getTaskQueuePosition,
  getTaskQueueStatus,
  listAvatars,
  listTasks,
  renameAvatar,
  submitTask,
  submitWithSubtitleTask,
} from './digitalHuman.controller.ts';

const router: Router = express.Router();

// ---- 数字人形象库（参考视频，供 HeyGem 换脸/对口型复用） ----
// 注意：静态段 /avatars 与 /avatars/:id 不冲突，顺序仍按「先具体后通配」。

// POST /api/digitalHuman/avatars — 上传参考视频并创建形象
//   （multipart：file/name 必填，userId 可选；视频时长须在 5–45 秒）
//   只做 ffmpeg 归一化 + 落库，不需要 GPU
router.post('/avatars', uploadSingle, createAvatar);

// GET /api/digitalHuman/avatars — 分页查询形象（query：userId 精确 + name 模糊，均可选；page/limit）
router.get('/avatars', listAvatars);

// GET /api/digitalHuman/avatars/:id — 形象详情
router.get('/avatars/:id', getAvatar);

// PUT /api/digitalHuman/avatars/:id — 修改形象名称（body：name，仅当前用户自己的记录）
router.put('/avatars/:id', renameAvatar);

// DELETE /api/digitalHuman/avatars/:id — 删除形象（假删除，仅当前用户自己的记录）
router.delete('/avatars/:id', deleteAvatar);

// ---- 数字人合成任务 ----
// 注意顺序：静态段 /tasks、/engine/status 必须注册在 /tasks/:taskId 之前。

// GET /api/digitalHuman/engine/status — 引擎与挂载配置状态
router.get('/engine/status', getEngineStatus);

// POST /api/digitalHuman/tasks — 提交数字人合成任务
//   （body：avatarId/voiceId/text 必填；speedMode 可选，缺省 balanced；burnSubtitles 可选，
//    true 时对配音音频生成字幕并烧录进成片；subtitleOptions 可选样式；userId 可选，回退 JWT）
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行（配音 → [字幕] → 对口型 → [烧录] → 落库）。
router.post('/tasks', submitTask);

// POST /api/digitalHuman/tasks/with-subtitle — 提交数字人合成任务（复用已有字幕任务）
//   （body：text/avatarId/voiceId/subtitleId 必填；subtitleOptions 可选样式；userId 可选，回退 JWT）
//   字幕取自 subtitleId 指定任务已生成的 SRT（不重跑 ASR），配音仍由服务端用 voiceId + text 合成；
router.post('/tasks/with-subtitle', submitWithSubtitleTask);

// GET /api/digitalHuman/tasks — 分页查询合成任务
//   （query：userId 精确可选，缺省回退当前登录用户；status 可选；page/limit）
router.get('/tasks', listTasks);

// GET /api/digitalHuman/tasks/queue/status — 数字人合成任务队列计数（全局：总数 / 等待中 / 运行中）
//   静态三段路径，须注册在 /tasks/:taskId 之前，避免被通配段吞掉
router.get('/tasks/queue/status', getTaskQueueStatus);

// GET /api/digitalHuman/tasks/:taskId — 任务详情与进度
//   （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
router.get('/tasks/:taskId', getTask);

// GET /api/digitalHuman/tasks/:taskId/queue — 排队位置
//   （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
router.get('/tasks/:taskId/queue', getTaskQueuePosition);

// POST /api/digitalHuman/tasks/:taskId/cancel — 取消排队中的数字人合成任务
//   （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
//   仅 pending 可取消：走仓储对 status=pending 的原子条件更新，与 dispatcher 的领取互斥，
//   取消成功后不会再被执行；已在运行/已终结的任务返回 409。
router.post('/tasks/:taskId/cancel', cancelTask);

export default router;
