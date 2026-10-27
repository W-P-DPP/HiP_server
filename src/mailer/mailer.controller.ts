import type { Request, Response } from 'express';
import { mailerService } from './mailer.service.ts';
import type { SendMailDto } from './mailer.dto.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** POST /api/mailer/send — 发送邮件（免 JWT） */
export const sendMail = async (req: Request, res: Response): Promise<void> => {
  try {
    const dto = req.body as SendMailDto;

    const hasTo =
      typeof dto.to === 'string'
        ? dto.to.trim().length > 0
        : Array.isArray(dto.to) && dto.to.length > 0;
    if (!hasTo || !dto.subject?.trim()) {
      res.sendFail('to、subject 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }
    if (!dto.text && !dto.html) {
      res.sendFail('text 与 html 至少提供一个', HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await mailerService.send(dto);
    if ('error' in result) {
      res.sendFail(result.error, result.code);
      return;
    }
    res.sendSuccess(result.sent, '邮件发送成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '邮件发送失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

/** GET /api/mailer/status — 邮件服务状态（免 JWT） */
export const getMailerStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.sendSuccess(mailerService.getStatus(), '查询成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
