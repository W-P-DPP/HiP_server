import mongoose from 'mongoose';
import { BaseMongoPlugin, type IBaseMongoEntity, type BaseDocument } from '../../utils/entities/base.mongo.entity.ts';
import MongoDBService from '../../utils/MongoDB.ts';
import { UserConstants } from '../../utils/constant/UserConstants.ts';
import type { User } from '../../type/index.d.ts';

/** User 实体字段（不含 Mongoose Document 方法） */
export interface IUser extends IBaseMongoEntity {
  /** 登录账号：邮箱或手机号（唯一） */
  account: string;
  /** bcrypt 密码哈希（select:false，默认不返回） */
  password: string;
  /** 昵称 */
  nickname: string;
  /** 头像 URL */
  avatar: string;
  /** 角色：user 普通用户 / admin 管理员 */
  role: User.Role;
  /** 父级用户 ObjectId（由创建方注入；顶层用户为 null，老文档可能缺失） */
  parentId?: mongoose.Types.ObjectId | null;
}

/** User Mongoose Document 类型 */
export type UserDocument = BaseDocument & IUser;

const UserSchema = new mongoose.Schema<UserDocument>(
  {
    account: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    nickname: {
      type: String,
      default: '',
    },
    avatar: {
      type: String,
      default: '',
    },
    role: {
      type: String,
      enum: [...UserConstants.USER_ROLES] as User.Role[],
      default: UserConstants.DEFAULT_USER_ROLE,
      index: true,
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'users',
  },
);

// 注入基础字段（createBy, updateBy, remark, flag, params）
UserSchema.plugin(BaseMongoPlugin);

const UserModel = MongoDBService.getInstance()
  .getMongoose()
  .model<UserDocument>('User', UserSchema);

export default UserModel;
