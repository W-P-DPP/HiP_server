import { MailerClient } from '../../utils/mailer.ts';
import { MailerConstants } from '../../utils/constant/MailerConstants.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import type { Mailer } from '../../type/index.d.ts';

/** 邮件发送业务服务：开关与配置前置校验，通过则同步发送 */
class MailerService {
  async send(
    dto: Mailer.SendMailDto,
  ): Promise<{ sent: Mailer.SendResult } | { error: string; code: number }> {
    if (!MailerConstants.ENABLED) {
      return { error: '邮件服务未启用', code: HttpStatus.SERVICE_UNAVAILABLE };
    }
    if (!MailerConstants.isConfigured()) {
      return {
        error: '邮件服务未配置（缺少 MAILER_HOST / MAILER_USER）',
        code: HttpStatus.SERVICE_UNAVAILABLE,
      };
    }
    try {
      const sent = await MailerClient.send(dto);
      return { sent };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : '邮件发送失败',
        code: HttpStatus.ERROR,
      };
    }
  }

  /** 邮件服务运行状态（不回连 SMTP，避免状态接口被网络拖慢） */
  getStatus(): Mailer.Status {
    return {
      enabled: MailerConstants.ENABLED,
      configured: MailerConstants.isConfigured(),
      host: MailerConstants.HOST,
      port: MailerConstants.PORT,
      secure: MailerConstants.SECURE,
      from: MailerConstants.FROM,
    };
  }
}

export const mailerService = new MailerService();
