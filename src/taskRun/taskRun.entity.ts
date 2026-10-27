import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** 任务运行结果状态 */
export type TaskRunStatus = 'success' | 'failed';

/** 任务运行记录实体字段（不含 Mongoose Document 方法） */
export interface ITaskRun extends IBaseMongoEntity {
  /** 关联的定时任务 id */
  taskId: string;
  /** 任务标题快照（任务被删除后仍可显示） */
  taskTitle: string;
  /** 所属用户 id */
  userId: string;
  /** 运行结果状态 */
  status: TaskRunStatus;
  /** 结果信息 / 错误信息 */
  message: string;
  /** 开始执行时间 */
  startedAt: Date;
  /** 结束执行时间 */
  finishedAt: Date;
}

/** 任务运行记录 Mongoose Document 类型 */
export type TaskRunDocument = BaseDocument & ITaskRun;

const TaskRunSchema = new mongoose.Schema<TaskRunDocument>(
  {
    taskId: {
      type: String,
      required: true,
      index: true,
    },
    taskTitle: {
      type: String,
      default: '',
      trim: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['success', 'failed'] as TaskRunStatus[],
      default: 'success',
      index: true,
    },
    message: {
      type: String,
      default: '',
      trim: true,
    },
    startedAt: {
      type: Date,
    },
    finishedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    collection: 'taskRuns',
  },
);

// 注入基础字段（createBy, updateBy, remark, params）
TaskRunSchema.plugin(BaseMongoPlugin);

const TaskRunModel = MongoDBService.getInstance()
  .getMongoose()
  .model<TaskRunDocument>('TaskRun', TaskRunSchema);

export default TaskRunModel;
