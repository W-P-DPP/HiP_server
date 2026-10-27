// utils/constant/FileConstants.ts
/** 文件服务常量 */
import path from 'node:path';

export class FileConstants {
  /** 上传文件存储根目录（./uploads 的绝对路径） */
  public static readonly UPLOAD_DIR: string = path.resolve('uploads');

  /** 单文件最大大小（字节） */
  public static readonly MAX_SIZE: number = 50 * 1024 * 1024;

  /** 允许的 MIME 类型。为空表示不限制 */
  public static readonly ALLOWED_TYPES: string[] = [];

  /** 静态文件访问路由前缀 */
  public static readonly STATIC_PREFIX: string = '/static/files';
}
