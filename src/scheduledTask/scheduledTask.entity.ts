import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 定时任务执行状态 */
export type ScheduledTaskStatus = 'pending' | 'running' | 'success' | 'failed';

/** 定时任务实体字段（不含 Mongoose Document 方法） */
export interface IScheduledTask extends IBaseMongoEntity {
  title: string;
  description: string;
  cron: string;
  workspace: string;
  status: ScheduledTaskStatus;
  userId: string;
}

/** 定时任务 Mongoose Document 类型 */
export type ScheduledTaskDocument = BaseDocument & IScheduledTask;

const ScheduledTaskSchema = new mongoose.Schema<ScheduledTaskDocument>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    cron: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed'] as ScheduledTaskStatus[],
      default: 'pending',
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    workspace: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: true,
    collection: 'scheduledTasks',
  },
);

// 注入基础字段（createBy, updateBy, remark, params）
ScheduledTaskSchema.plugin(BaseMongoPlugin);

const ScheduledTaskModel = MongoDBService.getInstance()
  .getMongoose()
  .model<ScheduledTaskDocument>('ScheduledTask', ScheduledTaskSchema);

export default ScheduledTaskModel;
