/** 用户模块常量 */
import type { User } from '../../type/index.d.ts';
import { SystemConstants } from './SystemConstants.ts';

export class UserConstants {
  /** 用户角色取值列表（Schema enum 校验用） */
  public static readonly USER_ROLES: readonly User.Role[] = ['user', 'admin', 'sadmin'] as const;
  /** 可创建子用户 / 查看后代的管理角色 */
  public static readonly PRIVILEGED_ROLES: readonly User.Role[] = ['admin', 'sadmin'] as const;
  /** 默认角色（注册用户） */
  public static readonly DEFAULT_USER_ROLE: User.Role = 'user';
  /** bcrypt 加盐轮数 */
  public static readonly BCRYPT_SALT_ROUNDS: number = 10;
  /** 邮箱格式正则 */
  public static readonly EMAIL_REGEX: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  /** 手机号格式正则（中国大陆 11 位） */
  public static readonly PHONE_REGEX: RegExp = /^1[3-9]\d{9}$/;
  /** 密码最小长度 */
  public static readonly PASSWORD_MIN_LENGTH: number = 6;
  /** 用户统计·每日新增趋势统计的天数（近半个月，含今日） */
  public static readonly STATS_DAILY_TREND_DAYS: number = 15;
  /** 用户统计·每日新增按自然日聚合的时区（与进程 TZ 对齐，默认东八区） */
  public static get STATS_TIMEZONE(): string {
    return SystemConstants.TIMEZONE;
  }
  /** 校验账号是否为邮箱或手机号 */
  public static isValidAccount(account: string): boolean {
    return UserConstants.EMAIL_REGEX.test(account) || UserConstants.PHONE_REGEX.test(account);
  }
}
