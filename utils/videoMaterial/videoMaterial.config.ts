// utils/videoMaterial/videoMaterial.config.ts
/** 视频素材库：大文件分片上传的体量/会话参数（环境变量读取点在 utils/constant/videoMaterial.ts 的 VideoMaterialConstants） */
import { VideoMaterialConstants } from '../constant/videoMaterial.ts';

const videoMaterialConfig = {
  /**
   * 合并后素材大小上限（字节）。分片上传的意义就是不受全局 FILE_MAX_SIZE（50MB）约束，
   * 故这里的上限独立给到 2.5GB（2684354560）；单片传输上限由 maxChunkBytes 单独约束（见下），两者不能混用：
   * 单片上限只管一次请求的体积，合并后上限才管最终落盘的素材。
   */
  maxBytes: VideoMaterialConstants.MAX_BYTES,

  /** 单个分片大小上限（字节），同时是分片路由 multer 的传输上限 */
  maxChunkBytes: VideoMaterialConstants.MAX_CHUNK_BYTES,

  /** 客户端未声明 chunkSize 时使用的建议分片大小（字节） */
  defaultChunkBytes: VideoMaterialConstants.CHUNK_BYTES,

  /** 分片数上限：每片至少落一个文件，防止 totalChunks 被填成天文数字耗光 inode */
  maxChunks: VideoMaterialConstants.MAX_CHUNKS,

  /**
   * 未完成会话的存活时长（ms）。分片上传没有常驻调度器，故在新建会话时顺带清理超期会话目录，
   * 让异常中断（客户端放弃、进程被杀）留下的分片不会永久占盘。取值须大于一次完整上传的耗时。
   */
  sessionTtlMs: VideoMaterialConstants.SESSION_TTL_MS,
} as const;

export default videoMaterialConfig;
