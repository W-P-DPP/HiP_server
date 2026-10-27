import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/**
 * 数字人形象库记录（参考视频 + 名称）。
 *
 * 与音色库的差异：音色的参考音归一化后原始素材即可丢弃，而参考视频**每次合成都要用**，
 * 因此这里长期保留归一化后的 mp4（file 表 + 磁盘），任务阶段再 stage 进 HeyGem 挂载目录。
 */
export interface IDigitalHumanAvatar extends IBaseMongoEntity {
  /** 形象名称（用户命名，同一用户内唯一） */
  name: string;
  /** 上传素材的原始文件名 */
  sourceOriginalName: string;
  /** 上传素材大小（字节） */
  sourceSize: number;
  /** 上传素材 MIME 类型 */
  sourceMimeType: string;
  /** 上传素材时长（秒），入库前已保证在 5–45 之间 */
  sourceDuration: number;
  /** 归一化后参考视频（mp4/h264）的 file 记录 id */
  referenceFileId: string;
  /** 参考视频相对 uploadDir 的路径（冗余存储，省一次 file 查询） */
  referencePath: string;
  /** 归一化后参考视频时长（秒） */
  referenceDuration: number;
  /** 推理后端，当前固定 heygem（预留多后端） */
  backend: string;
  /** 归属用户（未登录/未传时为空串） */
  userId: string;
}

/** 形象库记录 Mongoose Document 类型 */
export type DigitalHumanAvatarDocument = BaseDocument & IDigitalHumanAvatar;

const DigitalHumanAvatarSchema = new mongoose.Schema<DigitalHumanAvatarDocument>(
  {
    name: { type: String, required: true, trim: true, index: true },
    sourceOriginalName: { type: String, default: '' },
    sourceSize: { type: Number, default: 0 },
    sourceMimeType: { type: String, default: '' },
    sourceDuration: { type: Number, default: 0 },
    referenceFileId: { type: String, required: true, index: true },
    referencePath: { type: String, required: true },
    referenceDuration: { type: Number, default: 0 },
    backend: { type: String, default: 'heygem' },
    userId: { type: String, default: '', index: true },
  },
  {
    timestamps: true,
    collection: 'digitalHumanAvatars',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
DigitalHumanAvatarSchema.plugin(BaseMongoPlugin);

// 形象名称在同一用户内唯一；partialFilterExpression 只约束未删除记录，
// 使假删除后该名称可被重新使用（普通复合唯一索引会连已删除记录一起占用名称）。
DigitalHumanAvatarSchema.index(
  { userId: 1, name: 1 },
  { unique: true, partialFilterExpression: { flag: 1 } },
);

// 列表查询默认按创建时间倒序
DigitalHumanAvatarSchema.index({ userId: 1, createdAt: -1 });

const DigitalHumanAvatarModel = MongoDBService.getInstance()
  .getMongoose()
  .model<DigitalHumanAvatarDocument>('DigitalHumanAvatar', DigitalHumanAvatarSchema);

export default DigitalHumanAvatarModel;
