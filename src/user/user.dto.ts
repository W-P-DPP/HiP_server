import type { User } from '../../type/index.d.ts';

/** 注册入参 */
export interface RegisterDto {
  account: string;
  password: string;
  nickname?: string;
}

/** 登录入参 */
export interface LoginDto {
  account: string;
  password: string;
}

/** 更新用户入参（禁止修改 account；角色变更仅管理员可执行，由服务层鉴权） */
export interface UpdateUserDto {
  nickname?: string | undefined;
  avatar?: string | undefined;
  role?: User.Role | undefined;
  password?: string | undefined;
}

/** 新建子用户入参（镜像公开注册；parentId 由服务端注入恒为操作者本人，禁止前端传入） */
export interface CreateChildUserDto {
  account: string;
  password: string;
  nickname?: string;
  /** 目标角色（默认 user；不得高于创建者自身的角色等级，防提权） */
  role?: User.Role;
}
