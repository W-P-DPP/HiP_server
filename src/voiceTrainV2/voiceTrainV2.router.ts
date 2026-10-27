import express, { Router } from 'express';
import { uploadSingle } from '../../utils/middleware/uploadMiddleware.ts';
import {
  cancelSynthesisTask,
  createVoice,
  deleteVoice,
  getEngineStatus,
  getSynthesisQueuePosition,
  getSynthesisQueueStatus,
  getSynthesisTask,
  getVoice,
  listSynthesisTasks,
  listVoices,
  renameVoice,
  submitSynthesis,
} from './voiceTrainV2.controller.ts';

const router: Router = express.Router();

// ---- 音色库（零样本克隆：参考音归一化存盘，合成时作为 spk_audio_prompt） ----
// 注意：静态段 /voices 与 /voices/:id 不冲突，但顺序仍按「先具体后通配」以防日后新增子路径。

// POST /api/voiceTrainV2/voices — 上传训练音频并创建音色（multipart：file/resourceName 必填，promptText/userId 可选；
//   resourceName 同一用户内不可重复、音频时长不能低于 10 秒）
//   只做 ffmpeg 归一化 + 落库，不需要 GPU
router.post('/voices', uploadSingle, createVoice);

// GET /api/voiceTrainV2/voices — 分页查询音色（query：userId 精确 + resourceName 模糊，均可选；page/limit）
router.get('/voices', listVoices);

// GET /api/voiceTrainV2/voices/:id — 音色详情
router.get('/voices/:id', getVoice);

// PUT /api/voiceTrainV2/voices/:id — 修改音色名称（body：resourceName，仅当前用户自己的记录）
router.put('/voices/:id', renameVoice);

// DELETE /api/voiceTrainV2/voices/:id — 删除音色（假删除，仅当前用户自己的记录）
router.delete('/voices/:id', deleteVoice);

// ---- 合成（试听 / 正式合成） ----
// 注意顺序：/synthesize（列表）必须注册在 /synthesize/:taskId 之前，否则会被后者吞掉。

// GET /api/voiceTrainV2/engine/status — IndexTTS 引擎状态（GPU 指标走 /api/system/resources）
router.get('/engine/status', getEngineStatus);

// POST /api/voiceTrainV2/synthesize — 提交合成任务
//   （body：voiceId 必填；text/speedMode 可选；purpose 可选 preview=试听 / synthesis=正式合成，缺省 synthesis）
//   userId 可选：显式指定（query 优先、其次 body），缺省回退 JWT 登录身份
//   只建 pending 任务并返回 taskId，由 leader dispatcher 异步执行。
//   仅 purpose=preview 的任务成功后会把结果回写到音色的试听字段（listVoices 里可播放的那个）。
router.post('/synthesize', submitSynthesis);

// GET /api/voiceTrainV2/synthesize — 分页查询当前用户的合成任务（query：status 可选；page/limit）
router.get('/synthesize', listSynthesisTasks);

// GET /api/voiceTrainV2/synthesize/queue/status — 音色合成任务队列计数（全局：总数 / 等待中 / 运行中）
//   静态三段路径，须注册在 /synthesize/:taskId 之前，避免被通配段吞掉
router.get('/synthesize/queue/status', getSynthesisQueueStatus);

// GET /api/voiceTrainV2/synthesize/:taskId — 任务详情与进度（userId 可选：显式指定，缺省回退 JWT；须与任务归属一致）
router.get('/synthesize/:taskId', getSynthesisTask);

// GET /api/voiceTrainV2/synthesize/:taskId/queue — 排队位置（userId 可选：显式指定，缺省回退 JWT；须与任务归属一致）
//   4 段路径，不会与上面的 :taskId 三段路径冲突（Express 按整条路径匹配）
router.get('/synthesize/:taskId/queue', getSynthesisQueuePosition);

// POST /api/voiceTrainV2/synthesize/:taskId/cancel — 取消排队中的音色合成任务
//   （userId 可选：显式指定，缺省回退 JWT；须与任务归属一致）
//   仅 pending 可取消：走仓储对 status=pending 的原子条件更新，与 dispatcher 的领取互斥，
//   取消成功后不会再被执行；已在运行/已终结的任务返回 409。
router.post('/synthesize/:taskId/cancel', cancelSynthesisTask);

export default router;
