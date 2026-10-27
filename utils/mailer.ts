import nodemailer from 'nodemailer';
import type { SendMailOptions, SentMessageInfo, Transporter } from 'nodemailer';
import { Logger } from './Logger.ts';
import { MailerConstants } from './constant/MailerConstants.ts';
import type { Mailer } from '../type/index.d.ts';

/**
 * SMTP 邮件客户端。
 *
 * transporter 懒加载并复用（pool），配置缺失时报错而非静默失败；发送失败经 Logger 记录后抛出，
 * 由业务层（src/mailer）决定响应码。
 */
export class MailerClient {
  private static transporter: Transporter | null = null;

  private static getTransporter(): Transporter {
    if (!MailerClient.transporter) {
      if (!MailerConstants.isConfigured()) {
        throw new Error('邮件服务未配置：缺少 MAILER_HOST / MAILER_USER');
      }
      MailerClient.transporter = nodemailer.createTransport({
        host: MailerConstants.HOST,
        port: MailerConstants.PORT,
        secure: MailerConstants.SECURE,
        auth: {
          user: MailerConstants.USER,
          pass: MailerConstants.PASS,
        },
        pool: true,
      });
    }
    return MailerClient.transporter;
  }

  /** 发送一封邮件；配置缺失或 SMTP 报错时抛出 Error */
  static async send(dto: Mailer.SendMailDto): Promise<Mailer.SendResult> {
    const address = dto.from || MailerConstants.FROM;
    const from = MailerConstants.FROM_NAME
      ? { name: MailerConstants.FROM_NAME, address }
      : address;
    const options: SendMailOptions = {
      from,
      to: dto.to,
      subject: dto.subject,
      ...(dto.text ? { text: dto.text } : {}),
      ...(dto.html ? { html: dto.html } : {}),
      ...(dto.cc ? { cc: dto.cc } : {}),
      ...(dto.bcc ? { bcc: dto.bcc } : {}),
      ...(dto.replyTo ? { replyTo: dto.replyTo } : {}),
      ...(dto.attachments ? { attachments: dto.attachments } : {}),
    };
    try {
      const info = (await MailerClient.getTransporter().sendMail(options)) as SentMessageInfo;
      return {
        messageId: info.messageId ?? '',
        accepted: (info.accepted as string[] | undefined) ?? [],
        rejected: (info.rejected as string[] | undefined) ?? [],
        response: info.response ?? '',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.getInstance().error(`[mailer] 发送失败 to=${JSON.stringify(dto.to)}: ${message}`);
      throw new Error(`邮件发送失败：${message}`);
    }
  }

  /** 校验 SMTP 连接可用性（排障用），失败返回 false */
  static async verify(): Promise<boolean> {
    try {
      await MailerClient.getTransporter().verify();
      return true;
    } catch {
      return false;
    }
  }
}
