import mongoose, { type Schema, type Document } from 'mongoose';
import { getCurrentUserId } from '../requestContext.ts';

/**
 * Mongoose 基础 Entity 接口
 * 对标 TypeORM BaseEntity，为 MongoDB 实体提供统一的基础字段
 */
export interface IBaseMongoEntity {
  /** 创建者 */
  createBy: string;
  /** 更新者 */
  updateBy: string;
  /** 备注 */
  remark: string;
  /** 是否删除标记，默认 1，1 未删除 / 0 已删除 */
  flag: number;
  /** 扩展参数 */
  params: Record<string, unknown>;
}

/**
 * Mongoose Schema Plugin
 * 通过 Schema.plugin(BaseMongoPlugin) 注入基础字段
 *
 * 注意：createTime / updateTime 由 Mongoose timestamps 选项（createdAt / updatedAt）覆盖，
 * 不在 plugin 中重复定义。
 */
export function BaseMongoPlugin(schema: Schema): void {
  schema.add({
    createBy: {
      type: String,
      default: '',
      select: false,
    },
    updateBy: {
      type: String,
      default: '',
      select: false,
    },
    remark: {
      type: String,
      default: '',
      select: false,
    },
    flag: {
      type: Number,
      default: 1,
      select: false,
    },
    params: {
      type: mongoose.Schema.Types.Mixed,
      default: {} as Record<string, unknown>,
    },
  });

  // createBy/updateBy 自动填充（从请求上下文读取 JWT userid）。
  // 注意：Mongoose 9 pre 钩子首参是 opts 而非 next，勿写 next() 风格的中间件。
  schema.pre('save', function () {
    const userId = getCurrentUserId();
    if (!userId) return;
    fillCreateBy(this as unknown as BaseMongoDocForHook, userId);
  });
  schema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
    const userId = getCurrentUserId();
    if (!userId) return;
    fillUpdateBy(this.getUpdate(), userId, this.getOptions().upsert === true);
  });
}

/**
 * 扩展 Document 类型，组合 IBaseMongoEntity
 * 业务 entity 的 interface 应 extends Document, IBaseMongoEntity
 */
export type BaseDocument = Document<unknown, Record<string, unknown>, IBaseMongoEntity> &
  IBaseMongoEntity & {
    _id: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
  };

/** pre('save') 钩子所需的最小文档形状（createBy/updateBy 由本插件注入） */
export interface BaseMongoDocForHook {
  isNew: boolean;
  createBy?: string;
  updateBy?: string;
}

/**
 * 纯函数（可单测）：新文档填充 createBy/updateBy，仅空时写入、尊重显式传值。
 * createBy 只在 isNew=true 时填充——字段 select:false，load-modify-save 的文档该字段为
 * undefined，按“为空就填”会把原创建者覆盖为当前操作者。
 */
export function fillCreateBy(doc: BaseMongoDocForHook, userId: string): void {
  if (doc.isNew && !doc.createBy) doc.createBy = userId;
  if (!doc.updateBy) doc.updateBy = userId;
}

/**
 * 纯函数（可单测）：向更新对象注入 updateBy。
 * - $set 形态 / 裸字段对象形态均处理；
 * - 纯操作符更新（$inc/$push 等，无 $set）不注入，避免把字符串写进数值操作符；
 * - upsert 时顺带 $setOnInsert.createBy，覆盖新插入（不走 pre('save')）的场景。
 */
export function fillUpdateBy(update: unknown, userId: string, isUpsert: boolean): void {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return;
  const up = update as Record<string, unknown>;
  const hasOperator = Object.keys(up).some((k) => k.startsWith('$'));
  if (hasOperator) {
    const set = up.$set as Record<string, unknown> | undefined;
    if (set && !set.updateBy) set.updateBy = userId;
  } else if (!up.updateBy) {
    up.updateBy = userId;
  }
  if (isUpsert) {
    const setOnInsert = (up.$setOnInsert ?? (up.$setOnInsert = {})) as Record<string, unknown>;
    if (!setOnInsert.createBy) setOnInsert.createBy = userId;
  }
}
