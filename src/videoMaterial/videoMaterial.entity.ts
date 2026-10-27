import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 视频素材库实体字段（不含 Mongoose Document 方法） */
export interface IVideoMaterial extends IBaseMongoEntity {
    /** 来源搜索词（raw，入库时原样保存，匹配时归一化比较） */
    keyword: string;
    /** 关联 files 记录 _id（string） */
    fileId: string;
    /** 清洗后的素材文件名（如 nature_forest.mp4，仅作展示；真实路径以 files 记录为准） */
    fileName: string;
    /** 所属分组 _id（空串表示未分组） */
    groupId: string;
    /** 复用命中次数 */
    hitCount: number;
}

/** VideoMaterial Mongoose Document 类型 */
export type VideoMaterialDocument = BaseDocument & IVideoMaterial;

const VideoMaterialSchema = new mongoose.Schema<VideoMaterialDocument>(
    {
        keyword: {
            type: String,
            required: true,
            trim: true,
        },
        fileId: {
            type: String,
            required: true,
        },
        fileName: {
            type: String,
            default: '',
        },
        groupId: {
            type: String,
            default: '',
            index: true,
        },
        hitCount: {
            type: Number,
            default: 0,
        },
    },
    {
        timestamps: true,
        collection: 'videoMaterials',
    },
);

// keyword 唯一性由应用层判重（create/update 查未删除记录），数据库不建唯一索引

// 注入基础字段（createBy, updateBy, remark, params）
VideoMaterialSchema.plugin(BaseMongoPlugin);

const VideoMaterialModel = MongoDBService.getInstance()
    .getMongoose()
    .model<VideoMaterialDocument>('VideoMaterial', VideoMaterialSchema);

export default VideoMaterialModel;
