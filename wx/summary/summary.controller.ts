import type { Request, Response } from 'express';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import dayjs from 'dayjs';
import { wxSummaryService, STATISTICS_MAX_RANGE_DAYS } from './summary.service.ts';
import type { GetSummaryDto } from './summary.dto.ts';

/** 从 JWT 解析当前用户 id，缺失时返回 401 并返回 undefined（statistics 等仍用；getSummary 改为上传 id） */
function requireUserId(req: Request, res: Response): string | undefined {
  const userId = req.jwtPayload?.id as string | undefined;
  if (!userId) {
    res.sendFail('未登录或缺少用户身份', HttpStatus.UNAUTHORIZED);
    return undefined;
  }
  return userId;
}

export const getSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, begin_date, end_date } = req.query as GetSummaryDto;
    // 目标用户由请求方上传，不从 JWT 解析
    if (!userId || !userId.trim()) {
      res.sendFail('缺少用户 id 参数', HttpStatus.BAD_REQUEST);
      return;
    }
    const date = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const summary = await wxSummaryService.getSummary(userId.trim(), {
      begin_date: begin_date ?? date,
      end_date: end_date ?? date,
    });
    if ('error' in summary) {
      res.sendFail(summary.error, HttpStatus.ERROR);
      return; // 必须 return：否则会继续执行 sendSuccess 造成双重响应
    }
    res.sendSuccess(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取统计数据失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};

// 数据统计
export const statistics = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const { begin_date, end_date } = req.query as GetSummaryDto;
    const date = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const begin = begin_date ?? date;
    const end = end_date ?? date;

    if (!dayjs(begin, 'YYYY-MM-DD', true).isValid() || !dayjs(end, 'YYYY-MM-DD', true).isValid()) {
      res.sendFail('日期格式应为 YYYY-MM-DD', HttpStatus.BAD_REQUEST);
      return;
    }
    if (dayjs(begin).isAfter(dayjs(end))) {
      res.sendFail('begin_date 不能晚于 end_date', HttpStatus.BAD_REQUEST);
      return;
    }
    if (dayjs(end).diff(dayjs(begin), 'day') > STATISTICS_MAX_RANGE_DAYS) {
      res.sendFail(`单次查询最多 ${STATISTICS_MAX_RANGE_DAYS} 天`, HttpStatus.BAD_REQUEST);
      return;
    }

    const result = await wxSummaryService.statistics(userId, { begin_date: begin, end_date: end });
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.ERROR);
      return; // 必须 return：否则会继续执行 sendSuccess 造成双重响应
    }
    res.sendSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取统计数据失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
