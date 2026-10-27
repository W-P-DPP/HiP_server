import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { userService } from './user.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import { UserConstants } from '../../utils/constant/UserConstants.ts';
import { CacheConstants } from '../../utils/constant/CacheConstants.ts';
import RedisService from '../../utils/Redis.ts';
import type {
  RegisterDto,
  LoginDto,
  UpdateUserDto,
  CreateChildUserDto,
} from './user.dto.ts';

/** POST /hip/auth/register — 注册 */
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const dto = req.body as RegisterDto;
    const account = dto.account?.trim() ?? '';

    if (!account || !dto.password) {
      res.sendFail('账号、密码为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }
    if (!UserConstants.isValidAccount(account)) {
      res.sendFail('账号格式不正确，请输入邮箱或手机号', HttpStatus.BAD_REQUEST);
      return;
    }
    if (dto.password.length < UserConstants.PASSWORD_MIN_LENGTH) {
      res.sendFail(`密码长度不能少于 ${UserConstants.PASSWORD_MIN_LENGTH} 位`, HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await userService.register({ ...dto, account });
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.CONFLICT);
      return;
    }
    res.sendSuccess(result.created, '注册成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '注册失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /hip/auth/login — 登录 */
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const dto = req.body as LoginDto;
    const account = dto.account?.trim() ?? '';

    if (!account || !dto.password) {
      res.sendFail('账号、密码为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await userService.login({ account, password: dto.password });
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.UNAUTHORIZED);
      return;
    }

    // 登录成功：JWT 写入 httpOnly cookie，供同源前端后续请求自动携带鉴权
    res.cookie('token', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: result.expiresIn * 1000,
    });

    res.sendSuccess({ token: result.token}, '登录成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '登录失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /hip/api/users/logout — 退出登录（删除 Redis 会话，立即使当前 token 失效） */
export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.jwtPayload as Record<string, unknown> | undefined;
    const userId = payload?.id;
    if (typeof userId === 'string') {
      await RedisService.getInstance().del(`${CacheConstants.SSO_TOKEN_KEY}${userId}`);
    }
    res.clearCookie('token', { httpOnly: true, sameSite: 'lax', path: '/' });
    res.sendSuccess(null, '退出成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '退出失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /hip/api/users/profile — 获取当前用户资料（从 token 解析 id） */
export const getProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.jwtPayload as Record<string, unknown> | undefined;
    const userId = payload?.id;
    if (!userId || typeof userId !== 'string') {
      res.sendFail('未登录或登录已过期', HttpStatus.UNAUTHORIZED);
      return;
    }

    const result = await userService.getProfile(userId);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.NOT_FOUND);
      return;
    }
    res.sendSuccess(result.profile);
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** PUT /hip/api/users/:id — 更新用户（管理员可操作任意用户；普通用户仅自己且不能改角色） */
export const updateUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.jwtPayload as Record<string, unknown> | undefined;
    const operatorId = payload?.id;
    if (!operatorId || typeof operatorId !== 'string') {
      res.sendFail('未登录或登录已过期', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto = req.body as UpdateUserDto;

    if (
      dto.nickname === undefined &&
      dto.avatar === undefined &&
      dto.role === undefined &&
      dto.password === undefined
    ) {
      res.sendFail('没有可更新的字段', HttpStatus.BAD_REQUEST);
      return;
    }
    if (dto.nickname !== undefined && (typeof dto.nickname !== 'string' || dto.nickname.trim().length === 0)) {
      res.sendFail('昵称不能为空', HttpStatus.BAD_REQUEST);
      return;
    }
    if (dto.avatar !== undefined && typeof dto.avatar !== 'string') {
      res.sendFail('头像地址格式不正确', HttpStatus.BAD_REQUEST);
      return;
    }
    if (dto.role !== undefined && !UserConstants.USER_ROLES.includes(dto.role)) {
      res.sendFail('非法的角色', HttpStatus.BAD_REQUEST);
      return;
    }
    if (dto.password !== undefined && dto.password.length < UserConstants.PASSWORD_MIN_LENGTH) {
      res.sendFail(`密码长度不能少于 ${UserConstants.PASSWORD_MIN_LENGTH} 位`, HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await userService.update(operatorId, id, dto);
    if ('error' in result) {
      res.sendFail(result.error, result.status);
      return;
    }
    res.sendSuccess(result.updated, '用户更新成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** DELETE /hip/api/users/:id — 删除用户（假删除；管理员可操作任意用户，普通用户仅自己） */
export const deleteUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.jwtPayload as Record<string, unknown> | undefined;
    const operatorId = payload?.id;
    if (!operatorId || typeof operatorId !== 'string') {
      res.sendFail('未登录或登录已过期', HttpStatus.UNAUTHORIZED);
      return;
    }

    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.sendFail('非法的 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await userService.delete(operatorId, id);
    if ('error' in result) {
      res.sendFail(result.error, result.status);
      return;
    }
    res.sendSuccess(null, '用户已删除');
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** POST /hip/api/users/children — 创建子用户（仅 admin/sadmin；parentId=操作者本人；role 可选且不得高于操作者等级） */
export const createChildUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.jwtPayload as Record<string, unknown> | undefined;
    const operatorId = payload?.id;
    if (!operatorId || typeof operatorId !== 'string') {
      res.sendFail('未登录或登录已过期', HttpStatus.UNAUTHORIZED);
      return;
    }

    const dto = req.body as CreateChildUserDto;
    const account = dto.account?.trim() ?? '';
    if (!account || !dto.password) {
      res.sendFail('账号、密码为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }
    if (!UserConstants.isValidAccount(account)) {
      res.sendFail('账号格式不正确，请输入邮箱或手机号', HttpStatus.BAD_REQUEST);
      return;
    }
    if (dto.password.length < UserConstants.PASSWORD_MIN_LENGTH) {
      res.sendFail(`密码长度不能少于 ${UserConstants.PASSWORD_MIN_LENGTH} 位`, HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await userService.createChild(operatorId, { ...dto, account });
    if ('error' in result) {
      res.sendFail(result.error, result.status);
      return;
    }
    res.sendSuccess(result.created, '子用户创建成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /hip/api/users/children — 查询当前 admin/sadmin 名下完整后代树（无分页/关键词，data.list=[以操作者为根的递归树]） */
export const listChildUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.jwtPayload as Record<string, unknown> | undefined;
    const operatorId = payload?.id;
    if (!operatorId || typeof operatorId !== 'string') {
      res.sendFail('未登录或登录已过期', HttpStatus.UNAUTHORIZED);
      return;
    }

    const result = await userService.listDescendantTree(operatorId);
    if ('error' in result) {
      res.sendFail(result.error, result.status);
      return;
    }
    res.sendSuccess(result); // data = { list: [以操作者为根的递归树] }
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /hip/api/users/stats — 用户数据统计（总数 / 今日·本周·本月新增 / 角色分布 / 近半个月每日新增；仅 admin/sadmin） */
export const getUserStatistics = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.jwtPayload as Record<string, unknown> | undefined;
    const operatorId = payload?.id;
    if (!operatorId || typeof operatorId !== 'string') {
      res.sendFail('未登录或登录已过期', HttpStatus.UNAUTHORIZED);
      return;
    }

    const result = await userService.getStatistics(operatorId);
    if ('error' in result) {
      res.sendFail(result.error, result.status);
      return;
    }
    res.sendSuccess(result, '查询成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '用户数据统计查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

