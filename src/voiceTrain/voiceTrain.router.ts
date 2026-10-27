import express, { Router } from 'express';
import { uploadSingle } from '../../utils/middleware/uploadMiddleware.ts';
import { raastResult,taskPipeLine, getPipelineStatus, getPipelineQueueStatus, listPipelineTasks, createAndSubmitAudio, createTrainTask, getTrainResult, getVoiceTrainResults, getPublicTrainResults, getAllTrainResults, updateTrainResultResourceName, getSynthesisStatus, submitAudio, getTrainTexts, synthesizeAudio, transcribeRaasr } from './voiceTrain.controller.ts';

const router: Router = express.Router();

// POST /api/voiceTrain/texts — 获取训练样本
router.post('/texts', getTrainTexts);

// POST /api/voiceTrain/task — 创建训练任务
router.post('/task', createTrainTask);

// POST /api/voiceTrain/audio — 上传音频并提交训练（multipart）
router.post('/audio', uploadSingle, submitAudio);

// POST /api/voiceTrain/task/submit — 上传音频并自动创建训练任务（multipart：userId/file/textSegId/resourceName/textId）
router.post('/task/submit', uploadSingle, createAndSubmitAudio);

// POST /api/voiceTrain/result — 查询训练结果
router.post('/result', getTrainResult);

// PUT /api/voiceTrain/result — 修改训练记录的音色名称（body：taskId/resourceName，仅允许改 resourceName）
router.put('/result', updateTrainResultResourceName);

// GET /api/voiceTrain/results — 分页查询当前用户的训练结果
router.get('/results', getVoiceTrainResults);

// GET /api/voiceTrain/results/public — 分页查询公共训练记录（userId 为空/缺失，不限用户）
router.get('/results/public', getPublicTrainResults);

// GET /api/voiceTrain/results/all — 分页查询全部训练记录（未删除，不限定 userId，含公共记录）
router.get('/results/all', getAllTrainResults);

// POST /api/voiceTrain/synthesize — 提交音频合成任务（异步，返回 taskId）
router.post('/synthesize', synthesizeAudio);

// GET /api/voiceTrain/synthesize/:taskId — 查询合成任务状态/结果
router.get('/synthesize/:taskId', getSynthesisStatus);

// POST /api/voiceTrain/task/pipeline — 任务管道生成视频（归属 userId 由 body 或 JWT 解析）
router.post('/task/pipeline', taskPipeLine);

// GET /api/voiceTrain/task/pipeline — 分页查询当前用户的视频生成任务
router.get('/task/pipeline', listPipelineTasks);

// GET /api/voiceTrain/task/pipeline/queue/status — 视频合成任务队列实时状态（须在 :taskId 路由前注册，避免被 taskId 匹配）
router.get('/task/pipeline/queue/status', getPipelineQueueStatus);

// GET /api/voiceTrain/task/pipeline/:taskId — 查询视频生成任务状态/结果（归属校验）
router.get('/task/pipeline/:taskId', getPipelineStatus);

// POST /api/voiceTrain/raasr — 录音文件转写（multipart，同步阻塞直至完成，直接返回转写文本）
router.post('/raasr', uploadSingle, transcribeRaasr);

// POST /api/voiceTrain/raasr/result — 云端获取录音文件转写结果
router.get('/raasr/result',  raastResult);

export default router;
