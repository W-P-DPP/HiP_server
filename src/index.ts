


import express, { Router } from "express";
import skillRouter from "./skill/skill.router.ts";
import subscriptionRouter from "./subscription/subscription.router.ts";
// import fileRouter from "./file/file.router.ts";
import scheduledTaskRouter from "./scheduledTask/scheduledTask.router.ts";
import taskRunRouter from "./taskRun/taskRun.router.ts";
import voiceTrainRouter from "./voiceTrain/voiceTrain.router.ts";
import voiceTrainV2Router from "./voiceTrainV2/voiceTrainV2.router.ts";
import digitalHumanRouter from "./digitalHuman/digitalHuman.router.ts";
import userRouter from "./user/user.router.ts";
import sessionRouter from "./session/session.router.ts";
import systemRouter from "./system/system.router.ts";
import wxAccountRouter from "./wxAccount/wxAccount.router.ts";
import dyAccountRouter from "./dyAccount/dyAccount.router.ts";
import videoMaterialRouter from "./videoMaterial/videoMaterial.router.ts";
import videoMaterialGroupRouter from "./videoMaterialGroup/videoMaterialGroup.router.ts";
import subtitleRouter from "./subtitle/subtitle.router.ts";
import videoPipelineV2Router from "./videoPipelineV2/videoPipelineV2.router.ts";
import narrationVideoRouter from "./narrationVideo/narrationVideo.router.ts";
import modelRouter from "./model/model.router.ts";
import aiDetectRouter from "./aiDetect/aiDetect.router.ts";
import vlmRouter from "./vlm/vlm.router.ts";
import vlmBatchRouter from "./vlmBatch/vlmBatch.router.ts";
import aiPlatformRouter from "./aiPlatform/aiPlatform.router.ts";
import aiChatRouter from "./aiChat/aiChat.router.ts";
import mailerRouter from "./mailer/mailer.router.ts";

const router: Router = express.Router();

// ---- Skill 市场 ----
router.use("/skills", skillRouter);
router.use("/subscriptions", subscriptionRouter);

// ---- 文件服务 ----
// router.use("/files", fileRouter);

// ---- 定时任务 ----
router.use("/scheduledTasks", scheduledTaskRouter);

// ---- 任务运行记录 ----
router.use("/taskRuns", taskRunRouter);

// ---- 音色训练 ----
router.use("/voiceTrain", voiceTrainRouter);

// ---- 音色训练 V2 ----
router.use("/voiceTrainV2", voiceTrainV2Router);

// ---- 数字人（形象库 + HeyGem 对口型合成） ----
router.use("/digitalHuman", digitalHumanRouter);

// ---- 字幕生成（音频 → SRT） ----
router.use("/subtitles", subtitleRouter);

// ---- 视频生成管道 V2（IndexTTS 配音 + Whisper 字幕 → 烧录合成） ----
router.use("/videoPipelineV2", videoPipelineV2Router);

// ---- 解说视频（解说结构化数据 → 源视频裁剪 + IndexTTS 配音 → 烧录字幕成片） ----
router.use("/narrationVideo", narrationVideoRouter);

// ---- 用户 ----
router.use("/users", userRouter);

// ---- Session（UUID 签发登记管理） ----
router.use("/sessions", sessionRouter);

// ---- 系统资源 ----
router.use("/system", systemRouter);

// ---- 微信公众号配置 ----
router.use("/wxAccounts", wxAccountRouter);

// ---- 抖音应用配置 ----
router.use("/dyAccounts", dyAccountRouter);

// ---- 视频素材库 ----
router.use("/videoMaterials", videoMaterialRouter);
router.use("/videoMaterialGroups", videoMaterialGroupRouter);

// ---- AI 模型（cmdc 平台） ----
router.use("/cmdc/models", modelRouter);

// ---- AI 检测（视频场景切分） ----
router.use("/aiDetect", aiDetectRouter);

// ---- 图片理解（Qwen3-VL 结构化描述） ----
router.use("/vlm", vlmRouter);

// ---- 批量图像识别（对抽帧关键帧逐张理解） ----
router.use("/vlmBatch", vlmBatchRouter);

// ---- AI 平台配置（commandcode / deepseek） ----
router.use("/aiPlatforms", aiPlatformRouter);

// ---- AI 对话（多轮会话 + SSE 流式） ----
router.use("/aiChat", aiChatRouter);

// ---- 邮件服务 ----
router.use("/mailer", mailerRouter);

export default router;
