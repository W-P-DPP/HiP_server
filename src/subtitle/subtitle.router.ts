import express, { Router, type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { uploadSingle, uploadSubtitleMedia } from '../../utils/middleware/uploadMiddleware.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import asrConfig from '../../utils/asr/asr.config.ts';
import {
  cancelTask,
  getEngineStatus,
  getTask,
  getTaskQueuePosition,
  getTaskQueueStatus,
  listTasks,
  submitSubtitleTask,
  submitSubtitleTaskFromMedia,
} from './subtitle.controller.ts';

const router: Router = express.Router();

/**
 * 把 multer 的「超过体积上限」翻成 400 业务提示。
 *
 * multer 抛出的错误默认会冒到全局 ErrorLogger 变成 500 —— 这条路由的上限放宽到 200MB 后这个场景
 * 很容易被触发，用户看到的却是一句系统错误。其余错误原样交回 next，走既有错误链路。
 */
const handleMediaUploadError: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = Math.round(asrConfig.maxVideoBytes / (1024 * 1024));
    res.sendFail(`文件大小不能超过 ${maxMb}MB`, HttpStatus.BAD_REQUEST);
    return;
  }
  next(err);
};

// ---- 字幕生成（音频/视频 → SRT） ----
// 注意顺序：静态段 /tasks、/engine/status 必须注册在 /tasks/:taskId 之前。

// GET /api/subtitles/engine/status — 引擎状态（通道配置、队列深度、本地 Whisper 可达性）
router.get('/engine/status', getEngineStatus);

// POST /api/subtitles/tasks — 提交字幕任务
//   （multipart：file 音频；或 JSON：fileId 引用已有文件；二者取其一，language/userId 可选）
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行（转写 → 落 SRT）。
router.post('/tasks', uploadSingle, submitSubtitleTask);

// POST /api/subtitles/tasks/from-media — 提交字幕任务（当场上传音频或视频）
//   （multipart：file 音频或视频必填；language/userId 可选）
//   音频直接用；视频先 ffmpeg 提取音频（提取失败/无音轨直接 400）。
//   该路由的传输上限独立放宽到 ASR_MAX_VIDEO_BYTES，业务上限仍按媒体类型区分（音频 ASR_MAX_AUDIO_BYTES）。
//   成功则与 POST /tasks 同样建 pending 任务，由 leader dispatcher 完成转写与落 SRT。
router.post('/tasks/from-media', uploadSubtitleMedia, handleMediaUploadError, submitSubtitleTaskFromMedia);

// GET /api/subtitles/tasks — 分页查询字幕任务
//   （query：userId 精确可选，缺省回退当前登录用户；status 可选；page/limit）
router.get('/tasks', listTasks);

// GET /api/subtitles/tasks/queue/status — 字幕任务队列计数（全局：总数 / 等待中 / 运行中）
//   静态三段路径，须注册在 /tasks/:taskId 之前，避免被通配段吞掉
router.get('/tasks/queue/status', getTaskQueueStatus);

// GET /api/subtitles/tasks/:taskId — 任务详情与进度
//   （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
router.get('/tasks/:taskId', getTask);

// GET /api/subtitles/tasks/:taskId/queue — 排队位置
//   （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
router.get('/tasks/:taskId/queue', getTaskQueuePosition);

// POST /api/subtitles/tasks/:taskId/cancel — 取消排队中的字幕任务
//   （query：userId 可选，缺省回退当前登录用户；须与该任务归属一致）
//   仅 pending 可取消：走仓储对 status=pending 的原子条件更新，与 dispatcher 的领取互斥，
//   取消成功后不会再被执行；已在运行/已终结的任务返回 409。
router.post('/tasks/:taskId/cancel', cancelTask);

export default router;
