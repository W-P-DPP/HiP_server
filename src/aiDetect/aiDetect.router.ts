import express, { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import multer from 'multer';
import { uploadDetectVideo, uploadDetectChunk } from '../../utils/middleware/uploadMiddleware.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import aiDetectConfig from '../../utils/aiDetect/aiDetect.config.ts';
import { readDetectChunkSession } from './aiDetectChunk.helper.ts';
import {
  abortSceneChunkUpload,
  cancelAsrTask,
  cancelFrameTask,
  cancelTask,
  getAsrEngineStatus,
  getAsrTask,
  getAsrTaskQueuePosition,
  getAsrTaskQueueStatus,
  getEngineStatus,
  getFrameEngineStatus,
  getFrameTask,
  getFrameTaskQueuePosition,
  getFrameTaskQueueStatus,
  getSceneChunkStatus,
  getTask,
  getTaskQueuePosition,
  getTaskQueueStatus,
  initSceneChunkUpload,
  listAsrTasks,
  listFrameTasks,
  listTasks,
  mergeScenes,
  submitAsrTask,
  submitFrameTask,
  submitSceneTask,
  uploadSceneChunk,
} from './aiDetect.controller.ts';

const router: Router = express.Router();

/**
 * 把 multer 的「超过体积上限」翻成 400 业务提示。
 *
 * multer 抛出的错误默认会冒到全局 ErrorLogger 变成 500 —— 这条路由的上限放到 2.5GB 后
 * 这个场景很容易被触发（选错文件、超过源视频上限），用户看到的却是一句系统错误。
 * 其余错误原样交回 next，走既有错误链路。
 */
const handleDetectUploadError: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = Math.round(aiDetectConfig.maxVideoBytes / (1024 * 1024));
    res.sendFail(`文件大小不能超过 ${maxMb}MB`, HttpStatus.BAD_REQUEST);
    return;
  }
  next(err);
};

/**
 * 分片落盘前的校验：会话必须存在、下标必须落在 0..totalChunks-1。
 *
 * 放在 multer 之前，是因为 multer 的 diskStorage 会按 uploadId/index 拼路径写文件 ——
 * 校验晚一步就意味着非法入参已经落到磁盘上（还会为不存在的会话凭空建目录）。
 * 与 videoMaterial.router.ts 的 validateMaterialChunk 同思路，只是会话目录不同。
 */
const validateDetectChunk: RequestHandler = (req, res, next) => {
  const indexRaw = req.params.index ?? '';
  const meta = readDetectChunkSession(req.params.uploadId ?? '');

  if (!meta) {
    res.sendFail('分片上传会话不存在或已过期', HttpStatus.NOT_FOUND);
    return;
  }
  if (!/^\d+$/.test(indexRaw)) {
    res.sendFail(`分片下标非法：须为 0..${meta.totalChunks - 1} 之间的整数`, HttpStatus.BAD_REQUEST);
    return;
  }

  const index = Number.parseInt(indexRaw, 10);
  if (index >= meta.totalChunks) {
    res.sendFail(`分片下标非法：须为 0..${meta.totalChunks - 1} 之间的整数`, HttpStatus.BAD_REQUEST);
    return;
  }
  next();
};

/** 把分片的体积/字段错误翻成 400 业务提示，其余错误交回 next（与 videoMaterial 同口径） */
const handleDetectChunkError: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = Math.round(aiDetectConfig.chunk.maxChunkBytes / (1024 * 1024));
      res.sendFail(`单个分片不能超过 ${maxMb}MB`, HttpStatus.BAD_REQUEST);
      return;
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      res.sendFail('分片字段名应为 chunk', HttpStatus.BAD_REQUEST);
      return;
    }
  }
  next(err);
};

// ---- AI 检测：视频场景切分 ----
// 注意顺序：静态段 /scene/tasks/queue/status、/scene/engine/status 必须注册在 /scene/tasks/:taskId 之前。

// GET /api/aiDetect/scene/engine/status — 引擎状态（开关、leader、队列深度、并发、最近进度）
router.get('/scene/engine/status', getEngineStatus);

// ---- 大文件分片上传（与整份上传同一上限；怕单个 GB 级请求中断时走这条，可断点续传）----
// POST /api/aiDetect/scene/chunks/init — 建分片会话（JSON：fileName + fileSize + totalChunks + chunkSize?）
router.post('/scene/chunks/init', initSceneChunkUpload);

// GET /api/aiDetect/scene/chunks/:uploadId — 分片进度（已收下标，供断点续传）
router.get('/scene/chunks/:uploadId', getSceneChunkStatus);

// POST /api/aiDetect/scene/chunks/:uploadId/:index — 上传单片（multipart：chunk）
router.post(
  '/scene/chunks/:uploadId/:index',
  validateDetectChunk,
  uploadDetectChunk,
  handleDetectChunkError,
  uploadSceneChunk,
);

// DELETE /api/aiDetect/scene/chunks/:uploadId — 放弃分片上传（删除会话目录与已收分片）
router.delete('/scene/chunks/:uploadId', abortSceneChunkUpload);

// POST /api/aiDetect/scene/tasks — 提交场景切分任务
//   （multipart：file 视频；或 JSON：uploadId 分片会话 / fileId 引用已有文件 / url 远程下载。四者取其一）
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行「场景检测 → 落时间段」。
//   源视频上限统一取 AI_DETECT_MAX_VIDEO_BYTES（默认 2.5GB，与素材库的大文件量级对齐）：
//   整份上传的传输上限、业务上限与分片合并上限三者同值，大文件不会被 200MB 这类旧口径挡在门外。
//   可选 blackDetectSec（秒）：>0 时额外做「首尾黑帧检测」，只扫首尾各这么长，把贴边的黑场另立为独立场景。
router.post('/scene/tasks', uploadDetectVideo, handleDetectUploadError, submitSceneTask);

// GET /api/aiDetect/scene/tasks — 分页查询场景切分任务
router.get('/scene/tasks', listTasks);

// GET /api/aiDetect/scene/tasks/queue/status — 场景切分队列的计数（全局：总数 / 等待中 / 运行中）
router.get('/scene/tasks/queue/status', getTaskQueueStatus);

// GET /api/aiDetect/scene/tasks/:taskId — 任务详情与进度（成功后含 scenes）
router.get('/scene/tasks/:taskId', getTask);

// GET /api/aiDetect/scene/tasks/:taskId/queue — 排队位置
router.get('/scene/tasks/:taskId/queue', getTaskQueuePosition);

// POST /api/aiDetect/scene/tasks/:taskId/cancel — 取消排队中的任务（仅 pending）
router.post('/scene/tasks/:taskId/cancel', cancelTask);

// POST /api/aiDetect/scene/tasks/:taskId/merge — 按场景序号分组合并（同步接口）
//   JSON：groups = [[1,2],[3,4,5]]，每组 ≥2 个连续的场景序号并成一个新场景，未列出的场景原样保留。
//   不建任务、不入队，但会**写回该场景任务**（scenes/sceneCount 被覆盖，原划分不可撤销）；
//   序号始终指任务当前划分，可反复调用；已有抽帧/转写任务的任务拒绝合并（409）。
router.post('/scene/tasks/:taskId/merge', mergeScenes);

// ---- AI 检测：场景关键帧抽帧 ----
// 输入是「已完成的场景切分任务」而不是源视频：这一组接口不接上传、也没有分片上传，请求体只有 taskId。
// 抽帧在**自己的表与队列**上执行，故并发额度（AI_DETECT_FRAME_CONCURRENCY）、队列计数、引擎状态
// 都与场景切分各算各的 —— 场景侧那两个端点不再覆盖抽帧任务。
// 注意顺序：静态段与 /:taskId/xxx 必须注册在 /:taskId 之前。

// GET /api/aiDetect/frames/engine/status — 抽帧队列的引擎状态（开关、leader、队列深度、并发、最近进度）
router.get('/frames/engine/status', getFrameEngineStatus);

// GET /api/aiDetect/frames/tasks/queue/status — 抽帧队列的计数（总数 / 等待中 / 运行中）
router.get('/frames/tasks/queue/status', getFrameTaskQueueStatus);

// POST /api/aiDetect/frames/tasks — 提交抽帧任务（JSON：taskId = 已完成的场景切分任务 id，可选 userId）
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行
//   「逐场景抽开始/中间/结束三帧 → 逐帧登记 file 表」。
router.post('/frames/tasks', submitFrameTask);

// GET /api/aiDetect/frames/tasks — 分页查询抽帧任务
router.get('/frames/tasks', listFrameTasks);

// GET /api/aiDetect/frames/tasks/:taskId/queue — 排队位置（只算抽帧队列）
router.get('/frames/tasks/:taskId/queue', getFrameTaskQueuePosition);

// GET /api/aiDetect/frames/tasks/:taskId — 抽帧任务详情与进度（成功后含每场景的三帧）
router.get('/frames/tasks/:taskId', getFrameTask);

// POST /api/aiDetect/frames/tasks/:taskId/cancel — 取消排队中的抽帧任务（仅 pending）
router.post('/frames/tasks/:taskId/cancel', cancelFrameTask);

// ---- AI 检测：场景语音转写 ----
// 与抽帧同构：入参是「已完成的场景切分任务 id」，不接上传。执行时把音频块交给 subtitle 模块的
// Whisper 链路转写，再把文本段按场景归并，故产物是数据而不是文件。
// 三条队列各有一套并发额度/队列计数/引擎状态；本组是第三套（AI_DETECT_ASR_CONCURRENCY）。
// 顺序约束同前：静态段与 /:taskId/xxx 注册在 /:taskId 之前。

// GET /api/aiDetect/asr/engine/status — 转写队列的引擎状态
router.get('/asr/engine/status', getAsrEngineStatus);

// GET /api/aiDetect/asr/tasks/queue/status — 转写队列的计数（总数 / 等待中 / 运行中）
router.get('/asr/tasks/queue/status', getAsrTaskQueueStatus);

// POST /api/aiDetect/asr/tasks — 提交转写任务（JSON：taskId = 已完成的场景切分任务 id，可选 userId）
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行
//   「按固定时长切块抽音频 → 逐块走 subtitle 的转写链路 → 按场景归并文本」。
router.post('/asr/tasks', submitAsrTask);

// GET /api/aiDetect/asr/tasks — 分页查询转写任务
router.get('/asr/tasks', listAsrTasks);

// GET /api/aiDetect/asr/tasks/:taskId/queue — 排队位置（只算转写队列）
router.get('/asr/tasks/:taskId/queue', getAsrTaskQueuePosition);

// GET /api/aiDetect/asr/tasks/:taskId — 转写任务详情与进度（成功后含 segments + sceneSegments）
router.get('/asr/tasks/:taskId', getAsrTask);

// POST /api/aiDetect/asr/tasks/:taskId/cancel — 取消排队中的转写任务（仅 pending）
router.post('/asr/tasks/:taskId/cancel', cancelAsrTask);

export default router;
