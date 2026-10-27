// utils/constant/MailerConstants.ts
/** 邮件服务（Nodemailer SMTP）常量 */
import { envBool, envInt, envStr } from './envParse.ts';

export class MailerConstants {
  /** 邮件服务总开关（MAILER_ENABLED，默认 true） */
  public static readonly ENABLED: boolean = envBool('MAILER_ENABLED', true);

  /** SMTP 发件服务器地址（MAILER_HOST） */
  public static readonly HOST: string = envStr('MAILER_HOST');

  /** SMTP 发件服务器端口（MAILER_PORT） */
  public static readonly PORT: number = envInt('MAILER_PORT', 587);

  /** 是否使用 TLS（MAILER_SECURE=true） */
  public static readonly SECURE: boolean = envBool('MAILER_SECURE', false);

  /** SMTP 发件账号（MAILER_USER） */
  public static readonly USER: string = envStr('MAILER_USER');

  /** SMTP 发件密码（MAILER_PASS） */
  public static readonly PASS: string = envStr('MAILER_PASS');

  /** 发件人显示名（MAILER_FROM_NAME） */
  public static readonly FROM_NAME: string = envStr('MAILER_FROM_NAME');

  /** 发件人地址（MAILER_FROM，缺省回退 MAILER_USER） */
  public static readonly FROM: string = envStr('MAILER_FROM', envStr('MAILER_USER'));

  /** HOST + USER 齐备才认为可发信 */
  public static isConfigured(): boolean {
    return Boolean(MailerConstants.HOST && MailerConstants.USER);
  }
}
