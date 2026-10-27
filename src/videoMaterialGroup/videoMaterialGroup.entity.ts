import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 视频素材分组实体字段（不含 Mongoose Document 方法） */
export interface IVideoMaterialGroup extends IBaseMongoEntity {
    /** 分组名称（同一用户下不重名，按 createBy 应用层判重） */
    name: string;
}

/** VideoMaterialGroup Mongoose Document 类型 */
export type VideoMaterialGroupDocument = BaseDocument & IVideoMaterialGroup;

const VideoMaterialGroupSchema = new mongoose.Schema<VideoMaterialGroupDocument>(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
    },
    {
        timestamps: true,
        collection: 'videoMaterialGroups',
    },
);

// name 唯一性由应用层按 createBy 判重（create/update 查未删除记录），数据库不建唯一索引

// 注入基础字段（createBy, updateBy, remark, params）
VideoMaterialGroupSchema.plugin(BaseMongoPlugin);

const VideoMaterialGroupModel = MongoDBService.getInstance()
    .getMongoose()
    .model<VideoMaterialGroupDocument>('VideoMaterialGroup', VideoMaterialGroupSchema);

export default VideoMaterialGroupModel;
