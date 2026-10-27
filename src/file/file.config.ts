import { FileConstants } from '../../utils/constant/FileConstants.ts';

/** 文件服务配置 */
const fileConfig = {
  /** 上传文件存储根目录 */
  uploadDir: FileConstants.UPLOAD_DIR,

  /** 单文件最大大小（字节），默认 50MB */
  maxFileSize: FileConstants.MAX_SIZE,

  /** 允许的 MIME 类型（逗号分隔），为空表示不限制 */
  allowedTypes: FileConstants.ALLOWED_TYPES,

  /** 静态文件访问路由前缀 */
  staticPrefix: FileConstants.STATIC_PREFIX,
} as const;

export default fileConfig;
