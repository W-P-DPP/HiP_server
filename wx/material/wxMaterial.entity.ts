import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import type { WxMediaType } from '../../utils/wx/wx.d.ts';

/** 微信公众号素材上传记录实体字段（不含 Mongoose Document 方法） */
export interface IWxMaterial extends IBaseMongoEntity {
  /** 素材类型：图片（image）、语音（voice）、视频（video）、缩略图（thumb） */
  type: WxMediaType;
  /** 微信返回的永久素材 media_id */
  mediaId: string;
  /** 图片素材专属：图片 URL */
  url?: string;
  /** 上传的原始文件名 */
  fileName: string;
  /** 文件大小（字节） */
  fileSize: number;
  /** 本地存储相对路径（uploads 目录下） */
  filePath: string;
  /** 视频素材标题 */
  title?: string;
  /** 视频素材简介 */
  introduction?: string;
}

/** 上传记录 Mongoose Document 类型 */
export type WxMaterialDocument = BaseDocument & IWxMaterial;

const WxMaterialSchema = new mongoose.Schema<WxMaterialDocument>(
  {
    type: {
      type: String,
      enum: ['image', 'voice', 'video', 'thumb'] as WxMediaType[],
      required: true,
      index: true,
    },
    mediaId: {
      type: String,
      required: true,
      index: true,
    },
    url: {
      type: String,
      default: '',
    },
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
    fileSize: {
      type: Number,
      required: true,
    },
    filePath: {
      type: String,
      default: '',
    },
    title: {
      type: String,
      default: '',
      trim: true,
    },
    introduction: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
    collection: 'wxMaterials',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
WxMaterialSchema.plugin(BaseMongoPlugin);

const WxMaterialModel = MongoDBService.getInstance()
  .getMongoose()
  .model<WxMaterialDocument>('WxMaterial', WxMaterialSchema);

export default WxMaterialModel;
