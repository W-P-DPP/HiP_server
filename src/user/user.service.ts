import { hash, compare } from 'bcryptjs';
import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { userRepository } from './user.repository.ts';
import { generateToken } from '../../utils/middleware/jwtMiddleware.ts';
import { JwtConstants } from '../../utils/constant/JwtConstants.ts';
import { UserConstants } from '../../utils/constant/UserConstants.ts';
import { CacheConstants } from '../../utils/constant/CacheConstants.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import RedisService from '../../utils/Redis.ts';
import type {
  RegisterDto,
  LoginDto,
  UpdateUserDto,
  CreateChildUserDto,
} from './user.dto.ts';
import type { UserDocument } from './user.entity.ts';
import type { CreateUserData, UpdateUserData } from './user.repository.ts';
import type { User } from '../../type/index.d.ts';

/** 规范化账号：去空格 + 转小写（与 Schema 的 trim/lowercase 对齐） */
function normalizeAccount(account: string): string {
  return account.trim().toLowerCase();
}

/** 脱敏：显式挑选字段，绝不外泄密码哈希 */
function toProfile(user: UserDocument): User.Profile {
  return {
    id: user._id.toString(),
    account: user.account,
    nickname: user.nickname,
    avatar: user.avatar,
    role: user.role,
    parentId: user.parentId ? String(user.parentId) : null, // 兼容 ObjectId/string/null/缺失（老文档）
    createdAt: user.createdAt,
  };
}

/** 本地时区当日 00:00:00（统计「今日新增」的起点） */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 近 days 天（含今日）的本地自然日 KEY，升序，格式与仓储 $dateToString 的 %Y-%m-%d 对齐 */
function recentDayKeys(days: number): string[] {
  const today = dayjs().startOf('day');
  return Array.from({ length: days }, (_, i) =>
    today.subtract(days - 1 - i, 'day').format('YYYY-MM-DD'),
  );
}

/** 按 parentId 把全部后代文档挂到 root 名下，拼出以 root 为根的全层级递归树；每层 children 按 createdAt 降序、_id 降序排列。 */
function buildDescendantTree(root: UserDocument, descendants: UserDocument[]): User.TreeNode {
  const nodes = new Map<string, User.TreeNode>();
  const toNode = (doc: UserDocument): User.TreeNode => ({ ...toProfile(doc), children: [] });

  nodes.set(root._id.toString(), toNode(root));
  for (const d of descendants) nodes.set(d._id.toString(), toNode(d));

  for (const d of descendants) {
    const node = nodes.get(d._id.toString());
    const pid = d.parentId ? d.parentId.toString() : '';
    const parent = nodes.get(pid);
    if (node && parent) parent.children.push(node); // 理论必命中：每层的父级要么是 root 要么也在结果集内
  }

  const byNewest = (a: User.TreeNode, b: User.TreeNode): number =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);
  const sortChildren = (node: User.TreeNode): void => {
    node.children.sort(byNewest);
    node.children.forEach(sortChildren);
  };
  sortChildren(nodes.get(root._id.toString())!);
  return nodes.get(root._id.toString())!;
}

class UserService {
  /**
   * 账号查重 + 建号（账号已假删除则复活，避免唯一索引冲突）。
   * account 需已归一化；parentId 省略时显式置 null（公开注册始终为顶层用户，复活也不残留旧父级）；
   * role 省略时用默认 user（公开注册固定为 user；建子用户由 createChild 显式传入）。
   */
  private async ensureAccount(
    account: string,
    passwordPlain: string,
    nickname: string | undefined,
    parentId?: Types.ObjectId,
    role: User.Role = UserConstants.DEFAULT_USER_ROLE,
  ): Promise<{ created: UserDocument } | { error: string }> {
    const exists = await userRepository.existsByAccount(account);
    if (exists) return { error: '账号已存在' };

    const password = await hash(passwordPlain, UserConstants.BCRYPT_SALT_ROUNDS);
    const data: CreateUserData = { account, password, nickname, role, parentId: parentId ?? null };

    // 假删除恢复：同账号 flag:0 记录存在则恢复（重新哈希密码并按需归属父级），否则新建
    const restored = await userRepository.restoreByAccount(account, data);
    if (restored) return { created: restored };
    return { created: await userRepository.create(data) };
  }

  /** 鉴权守卫：仅 admin/sadmin 可创建子用户 / 查看后代；返回该操作者（未删、未注销） */
  private async requirePrivilegedOperator(
    operatorId: string,
  ): Promise<UserDocument | { error: string; status: number }> {
    if (!Types.ObjectId.isValid(operatorId)) {
      return { error: '用户不存在或已注销', status: HttpStatus.UNAUTHORIZED };
    }
    const operator = await userRepository.findById(operatorId);
    if (!operator) {
      return { error: '用户不存在或已注销', status: HttpStatus.UNAUTHORIZED };
    }
    if (!UserConstants.PRIVILEGED_ROLES.includes(operator.role)) {
      return { error: '无权限执行此操作', status: HttpStatus.FORBIDDEN };
    }
    return operator;
  }

  /** 注册（始终为顶层用户，无父级） */
  async register(dto: RegisterDto): Promise<{ created: User.Profile } | { error: string }> {
    const account = normalizeAccount(dto.account);
    const result = await this.ensureAccount(account, dto.password, dto.nickname);
    if ('error' in result) return { error: result.error };
    return { created: toProfile(result.created) };
  }

  /**
   * 创建子用户（仅 admin/sadmin；parentId 恒为操作者本人）。
   * role 可选（默认 user）：子角色等级不得高于操作者自身（USER_ROLES 有序，admin 无法造出 sadmin），防提权。
   */
  async createChild(
    operatorId: string,
    dto: CreateChildUserDto,
  ): Promise<{ created: User.Profile } | { error: string; status: number }> {
    const operatorResult = await this.requirePrivilegedOperator(operatorId);
    if ('error' in operatorResult) return operatorResult;
    const operator = operatorResult;

    const role = dto.role ?? UserConstants.DEFAULT_USER_ROLE;
    if (!UserConstants.USER_ROLES.includes(role)) {
      return { error: '非法的角色', status: HttpStatus.BAD_REQUEST };
    }
    const grantedRank = UserConstants.USER_ROLES.indexOf(role);
    const operatorRank = UserConstants.USER_ROLES.indexOf(operator.role);
    if (grantedRank > operatorRank) {
      return { error: '不能创建角色等级高于自己的子用户', status: HttpStatus.FORBIDDEN };
    }

    const account = normalizeAccount(dto.account);
    const result = await this.ensureAccount(account, dto.password, dto.nickname, operator._id, role);
    if ('error' in result) return { error: result.error, status: HttpStatus.CONFLICT };
    return { created: toProfile(result.created) };
  }

  /** 查询当前 admin/sadmin 名下完整后代树（无分页/关键词；返回 { list: [以操作者为根的树] }） */
  async listDescendantTree(
    operatorId: string,
  ): Promise<{ list: User.TreeNode[] } | { error: string; status: number }> {
    const operatorResult = await this.requirePrivilegedOperator(operatorId);
    if ('error' in operatorResult) return operatorResult;
    const operator = operatorResult;

    const descendants = await userRepository.findDescendantDocs(operator._id);
    return { list: [buildDescendantTree(operator, descendants)] };
  }

  /** 用户数据统计（仅 admin/sadmin）：总数 / 今日新增 / 角色分布 / 近半个月每日新增，均只统计未删除用户 */
  async getStatistics(
    operatorId: string,
  ): Promise<User.Statistics | { error: string; status: number }> {
    const operatorResult = await this.requirePrivilegedOperator(operatorId);
    if ('error' in operatorResult) return operatorResult;

    const days = UserConstants.STATS_DAILY_TREND_DAYS;
    const trendStart = dayjs().startOf('day').subtract(days - 1, 'day').toDate();

    const [total, newToday, roleRows, dailyRows] = await Promise.all([
      userRepository.countAll(),
      userRepository.countCreatedSince(startOfToday()),
      userRepository.countGroupByRole(),
      userRepository.countDailyCreatedSince(trendStart, UserConstants.STATS_TIMEZONE),
    ]);

    const byRole = {} as Record<User.Role, number>;
    for (const role of UserConstants.USER_ROLES) byRole[role] = 0;
    for (const row of roleRows) byRole[row.role] = row.count;

    // 聚合只返回有数据的日期，按完整的近 N 天日历补齐缺日为 0
    const dailyCounts = new Map(dailyRows.map((row) => [row.date, row.count]));
    const dailyNew: User.DailyNewUsers[] = recentDayKeys(days).map((date) => ({
      date,
      count: dailyCounts.get(date) ?? 0,
    }));

    return { total, newToday, byRole, dailyNew };
  }

  /** 登录：校验账号与密码，签发 JWT */
  async login(dto: LoginDto): Promise<User.LoginResult | { error: string }> {
    const account = normalizeAccount(dto.account);

    const user = await userRepository.findByAccountWithPassword(account);
    if (!user) return { error: '账号或密码错误' };

    const ok = await compare(dto.password, user.password);
    if (!ok) return { error: '账号或密码错误' };

    const expiresIn = JwtConstants.EXPIRES_IN;
    const token = generateToken({ id: user._id.toString(), account: user.account }, expiresIn);
    // 单点登录：token 写入 Redis（TTL 与 JWT 对齐；同账号再次登录会覆盖旧 token，使旧会话失效）
    await RedisService.getInstance().set(`${CacheConstants.SSO_TOKEN_KEY}${user._id.toString()}`, token, expiresIn);
    return { token, expiresIn, user: toProfile(user) };
  }

  /** 获取当前用户资料 */
  async getProfile(userId: string): Promise<{ profile: User.Profile } | { error: string }> {
    if (!Types.ObjectId.isValid(userId)) return { error: '用户不存在' };
    const user = await userRepository.findById(userId);
    if (!user) return { error: '用户不存在' };
    return { profile: toProfile(user) };
  }

  /** 更新用户（admin/sadmin 可操作任意用户；普通用户仅可更新自己，且不能修改角色） */
  async update(
    operatorId: string,
    id: string,
    dto: UpdateUserDto,
  ): Promise<{ updated: User.Profile } | { error: string; status: number }> {
    if (!Types.ObjectId.isValid(id)) return { error: '用户不存在', status: HttpStatus.NOT_FOUND };
    if (!Types.ObjectId.isValid(operatorId)) return { error: '用户不存在或已注销', status: HttpStatus.UNAUTHORIZED };

    const operator = await userRepository.findById(operatorId);
    if (!operator) return { error: '用户不存在或已注销', status: HttpStatus.UNAUTHORIZED };

    const isPrivileged = UserConstants.PRIVILEGED_ROLES.includes(operator.role);
    if (!isPrivileged && id !== operatorId) {
      return { error: '无权操作其他用户', status: HttpStatus.FORBIDDEN };
    }

    // 普通用户禁止修改角色（防提权）；admin/sadmin 可改角色
    if (!isPrivileged && dto.role !== undefined) {
      return { error: '无权修改角色', status: HttpStatus.FORBIDDEN };
    }

    // 显式挑选可写字段（account 不可改；未知字段自然被忽略）
    const data: UpdateUserData = {};
    if (dto.nickname !== undefined) data.nickname = dto.nickname;
    if (dto.avatar !== undefined) data.avatar = dto.avatar;
    // 授予的角色等级不得高于操作者自身（USER_ROLES 有序；admin 不能把人升成 sadmin，防提权）
    if (isPrivileged && dto.role !== undefined) {
      if (!UserConstants.USER_ROLES.includes(dto.role)) {
        return { error: '非法的角色', status: HttpStatus.BAD_REQUEST };
      }
      const targetRank = UserConstants.USER_ROLES.indexOf(dto.role);
      const operatorRank = UserConstants.USER_ROLES.indexOf(operator.role);
      if (targetRank > operatorRank) {
        return { error: '不能授予高于自身等级的角色', status: HttpStatus.FORBIDDEN };
      }
      data.role = dto.role;
    }
    if (dto.password !== undefined) {
      data.password = await hash(dto.password, UserConstants.BCRYPT_SALT_ROUNDS);
    }

    if (Object.keys(data).length === 0) {
      return { error: '没有可更新的字段', status: HttpStatus.BAD_REQUEST };
    }

    const updated = await userRepository.updateById(id, data);
    if (!updated) return { error: '用户不存在', status: HttpStatus.NOT_FOUND };
    return { updated: toProfile(updated) };
  }

  /** 删除用户（假删除 flag→0；admin/sadmin 可删任意用户，普通用户仅可删自己） */
  async delete(operatorId: string, id: string): Promise<{ error?: string; status?: number }> {
    if (!Types.ObjectId.isValid(id)) return { error: '用户不存在', status: HttpStatus.NOT_FOUND };
    if (!Types.ObjectId.isValid(operatorId)) return { error: '用户不存在或已注销', status: HttpStatus.UNAUTHORIZED };

    const operator = await userRepository.findById(operatorId);
    if (!operator) return { error: '用户不存在或已注销', status: HttpStatus.UNAUTHORIZED };

    const isPrivileged = UserConstants.PRIVILEGED_ROLES.includes(operator.role);
    if (!isPrivileged && id !== operatorId) {
      return { error: '无权操作其他用户', status: HttpStatus.FORBIDDEN };
    }

    const ok = await userRepository.softDeleteById(id);
    if (!ok) return { error: '用户不存在', status: HttpStatus.NOT_FOUND };
    return {};
  }
}

export const userService = new UserService();
