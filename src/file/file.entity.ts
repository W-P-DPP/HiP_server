import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 文件实体字段（不含 Mongoose Document 方法） */
export interface IFile extends IBaseMongoEntity {
  /** 原始文件名 */
  originalName: string;
  /** 存储文件名（UUID） */
  storedName: string;
  /** 相对存储路径 */
  path: string;
  /** 文件大小（字节） */
  size: number;
  /** MIME 类型 */
  mimeType: string;
  /** 文件扩展名 */
  ext: string;
  /** 文件 MD5 哈希（仅作元数据，不参与去重） */
  md5: string;
  /** 文件分类（可选） */
  category: string;
  /** 下载次数 */
  downloadCount: number;
  /** 扩展元数据 */
  metadata: Record<string, unknown>;
}

/** File Mongoose Document 类型 */
export type FileDocument = BaseDocument & IFile;

const FileSchema = new mongoose.Schema<FileDocument>(
  {
    originalName: {
      type: String,
      required: true,
      trim: true,
    },
    storedName: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    path: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
      min: 0,
    },
    mimeType: {
      type: String,
      required: true,
    },
    ext: {
      type: String,
      default: '',
    },
    md5: {
      type: String,
      default: '',
      index: true,
    },
    category: {
      type: String,
      default: '',
      index: true,
    },
    downloadCount: {
      type: Number,
      default: 0,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {} as Record<string, unknown>,
    },
  },
  {
    timestamps: true,
    collection: 'files',
  },
);

// 注入基础字段（createBy, updateBy, remark, params）
FileSchema.plugin(BaseMongoPlugin);

const FileModel = MongoDBService.getInstance()
  .getMongoose()
  .model<FileDocument>('File', FileSchema);

export default FileModel;
