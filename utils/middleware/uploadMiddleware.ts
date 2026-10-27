import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import fileConfig from '../../src/file/file.config.ts';
import asrConfig from '../asr/asr.config.ts';
import aiDetectConfig from '../aiDetect/aiDetect.config.ts';
import vlmConfig from '../vlm/vlm.config.ts';
import { chunkSessionDir } from '../chunkUpload/chunkSession.ts';
import { VIDEO_MATERIAL_CHUNK_PROFILE } from '../../src/videoMaterial/videoMaterialChunk.helper.ts';
import { AI_DETECT_CHUNK_PROFILE } from '../../src/aiDetect/aiDetectChunk.helper.ts';
import type { ChunkUpload } from '../../type/index.d.ts';

/** 确保上传目录存在 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 按日期生成存储子目录 */
function dateSubDir(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const dir = path.join(fileConfig.uploadDir, dateSubDir());
    ensureDir(dir);
    cb(null, dir);
  },
  filename(_req, file, cb) {
    // 生成 UUID 作为存储文件名，保留原始扩展名
    const uuid = crypto.randomUUID();
    const ext = path.extname(file.originalname);
    cb(null, `${uuid}${ext}`);
  },
});

/** 文件过滤器：仅允许白名单中的 MIME 类型 */
function fileFilter(_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (fileConfig.allowedTypes.length > 0) {
    if (fileConfig.allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件类型: ${file.mimetype}`));
    }
  } else {
    cb(null, true);
  }
}

/**
 * multipart 参数（即 filename）的字符集。
 * busboy 默认按 latin1 解码 Content-Disposition 里的 filename，浏览器发的是 UTF-8 字节，
 * 中文文件名会变成「å…¬å…±å¥³å£°.wav」这类乱码落库；显式指定 utf8 才能在 file.originalname
 * 拿到正确名称（纯 ASCII 文件名两种解码结果一致，不影响既有调用方）。
 */
const PARAM_CHARSET = 'utf8';

/** 单文件上传中间件 */
export const uploadSingle = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: fileConfig.maxFileSize,
  },
  defParamCharset: PARAM_CHARSET,
}).single('file');

/** 多文件上传中间件（最多 10 个文件） */
export const uploadMultiple = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: fileConfig.maxFileSize,
  },
  defParamCharset: PARAM_CHARSET,
}).array('files', 10);

/** Skill 创建专用：接受 file（skill 包）+ icon（图标）两个可选文件 */
export const uploadSkillFiles = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: fileConfig.maxFileSize,
  },
  defParamCharset: PARAM_CHARSET,
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'icon', maxCount: 1 },
]);

/**
 * 字幕媒体专用（音频或视频）：字段名/落盘目录/命名/字符集与 uploadSingle 完全一致，
 * 只把**传输**上限换成 ASR_MAX_VIDEO_BYTES（默认 200MB），因为视频按母带大小上传。
 *
 * 为什么不直接调大全局 FILE_MAX_SIZE：那条上限是给所有上传路由（skill 包、公众号素材、音色样本…）
 * 共用的，为字幕视频把它抬到几百 MB 等于顺带放宽了其它接口。这里的取舍是「按路由放传输上限」，
 * 再由 service 按媒体类型收紧业务上限（音频仍只允许 ASR_MAX_AUDIO_BYTES，超限的音频会被
 * 业务校验拒绝并连同刚上传的文件一起清掉）。
 */
export const uploadSubtitleMedia = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: asrConfig.maxVideoBytes,
  },
  defParamCharset: PARAM_CHARSET,
}).single('file');

/**
 * 场景切分专用（视频）：字段名/落盘目录/命名/字符集与 uploadSingle 完全一致，
 * 只把**传输**上限换成 AI_DETECT_MAX_VIDEO_BYTES（默认 2.5GB，与素材库的大文件量级对齐）。
 *
 * 与 uploadSubtitleMedia 同一取舍：按路由放传输上限，而不是抬升全局 FILE_MAX_SIZE ——
 * 后者是给所有上传接口（skill 包、公众号素材、音色样本…）共用的，为视频把它抬到 GB 级
 * 等于顺带放宽了其它接口。切分路由上传输上限、业务上限、分片合并上限三者同值，故 service
 * 侧只需再兜一道类型校验；怕单请求中断的客户端改走分片口径（uploadDetectChunk），上限一致。
 */
export const uploadDetectVideo = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: aiDetectConfig.maxVideoBytes,
  },
  defParamCharset: PARAM_CHARSET,
}).single('file');

/**
 * 分片上传中间件工厂：字段名 chunk（单片），落盘到**会话目录**
 * `<uploads>/<profile.subdir>/<uploadId>/<index>.part`。
 *
 * 为什么不复用 uploadSingle 的「日期子目录 + UUID 命名」：分片是中间产物，必须按会话聚合才能顺序
 * 合并、也才能整组删除；按会话存还天然带出断点续传（已存在的 .part 即「已收到」）。
 *
 * 传输上限取 profile.maxChunkBytes（默认 16MB）—— 分片的意义就是让单次请求不受全局 FILE_MAX_SIZE（50MB）
 * 约束；最终体量上限改由合并时按声明值校验（profile.maxBytes）。
 *
 * 不做 fileFilter：分片是不透明的字节流，类型只能按整份文件判断，已在 init 时按文件名定死。
 * 会话存在性、分片下标的合法性由各路由上的校验中间件先行把关，这里只负责落盘。
 */
function createChunkUpload(profile: ChunkUpload.Profile) {
  return multer({
    storage: multer.diskStorage({
      destination(req, _file, cb) {
        const dir = chunkSessionDir(fileConfig.uploadDir, req.params.uploadId ?? '', profile);
        ensureDir(dir);
        cb(null, dir);
      },
      filename(req, _file, cb) {
        cb(null, `${req.params.index ?? ''}.part`);
      },
    }),
    limits: {
      fileSize: profile.maxChunkBytes,
    },
  }).single('chunk');
}

/** 视频素材大文件分片专用：POST /api/videoMaterials/chunks/:uploadId/:index */
export const uploadMaterialChunk = createChunkUpload(VIDEO_MATERIAL_CHUNK_PROFILE);

/** 场景切分源视频分片专用：POST /api/aiDetect/scene/chunks/:uploadId/:index */
export const uploadDetectChunk = createChunkUpload(AI_DETECT_CHUNK_PROFILE);

/**
 * 图片理解专用（图片）：字段名/落盘目录/命名/字符集与 uploadSingle 完全一致，
 * 只把**传输**上限换成 VLM_MAX_IMAGE_BYTES（默认 20MB）。
 *
 * 与 uploadSubtitleMedia / uploadDetectVideo 同一取舍：按路由放传输上限，而不是抬升全局
 * FILE_MAX_SIZE —— 后者是给所有上传接口（skill 包、公众号素材、音色样本…）共用的。
 * 图片场景远小于视频，20MB 已远超模型实际会看的像素量。
 */
export const uploadVlmImage = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: vlmConfig.maxImageBytes,
  },
  defParamCharset: PARAM_CHARSET,
}).single('file');
