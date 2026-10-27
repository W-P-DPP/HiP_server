import mongoose, { type Schema } from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';

/** Skill 状态 */
export type SkillStatus = 'active' | 'inactive' | 'deprecated';

/** Skill 实体字段（不含 Mongoose Document 方法） */
export interface ISkill extends IBaseMongoEntity {
  key: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  tags: string[];
  icon: string;
  filePath: string;
  folders: string[];
  configSchema: Record<string, unknown>;
  status: SkillStatus;
  downloadCount: number;
  metadata: Record<string, unknown>;
}

/** Skill Mongoose Document 类型 */
export type SkillDocument = BaseDocument & ISkill;

const SkillSchema = new mongoose.Schema<SkillDocument>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    version: {
      type: String,
      default: '1.0.0',
    },
    author: {
      type: String,
      default: '',
    },
    category: {
      type: String,
      default: '',
      index: true,
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    icon: {
      type: String,
      default: '',
    },
    filePath: {
      type: String,
      required: true,
    },
    folders: {
      type: [String],
      default: [],
    },
    configSchema: {
      type: mongoose.Schema.Types.Mixed,
      default: {} as Record<string, unknown>,
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'deprecated'] as SkillStatus[],
      default: 'active',
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
    collection: 'skills',
  },
);

// 注入基础字段（createBy, updateBy, remark, params）
SkillSchema.plugin(BaseMongoPlugin);

const SkillModel = MongoDBService.getInstance()
  .getMongoose()
  .model<SkillDocument>('Skill', SkillSchema);

export default SkillModel;
