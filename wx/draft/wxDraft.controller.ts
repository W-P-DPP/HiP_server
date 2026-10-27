import type { Request, Response } from 'express';
import { wxDraftService } from './wxDraft.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';
import type { PublishDraftDto } from './wxDraft.dto.ts';

/** 从 JWT 解析当前用户 id，缺失时返回 401 并返回 undefined */
function requireUserId(req: Request, res: Response): string | undefined {
  const userId = req.jwtPayload?.id as string | undefined;
  if (!userId) {
    res.sendFail('未登录或缺少用户身份', HttpStatus.UNAUTHORIZED);
    return undefined;
  }
  return userId;
}

// content 上限 2 万字符（微信 draft/add 限制），markdown 转 HTML 后更长，这里留余量
const MAX_MARKDOWN_LENGTH = 20_000;

const toStringOpt = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined;

/** need_open_comment / only_fans_can_comment：字符串或数字收敛为 0|1 */
const toCommentFlag = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (n === 0 || n === 1) return n;
  throw new Error('need_open_comment / only_fans_can_comment 取值必须为 0 或 1');
};

/** POST /hip/wx/draft/publish — Markdown 发布为公众号草稿（JSON，纯透传） */
export const publishDraft = async (req: Request, res: Response): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const body = req.body as Record<string, unknown>;

    const markdown = toStringOpt(body.markdown);
    if (!markdown) {
      res.sendFail('markdown 为必填字段', HttpStatus.BAD_REQUEST);
      return;
    }
    if (markdown.length > MAX_MARKDOWN_LENGTH) {
      res.sendFail(`markdown 过长，请控制在 ${MAX_MARKDOWN_LENGTH} 字符以内`, HttpStatus.BAD_REQUEST);
      return;
    }

    let needOpenComment: number | undefined;
    let onlyFansCanComment: number | undefined;
    try {
      needOpenComment = toCommentFlag(body.need_open_comment);
      onlyFansCanComment = toCommentFlag(body.only_fans_can_comment);
    } catch (err) {
      res.sendFail(err instanceof Error ? err.message : '参数不合法', HttpStatus.BAD_REQUEST);
      return;
    }

    const dto: PublishDraftDto = {
      markdown,
      title: toStringOpt(body.title),
      author: toStringOpt(body.author),
      digest: toStringOpt(body.digest),
      content_source_url: toStringOpt(body.content_source_url),
      thumb_media_id: toStringOpt(body.thumb_media_id),
      need_open_comment: needOpenComment,
      only_fans_can_comment: onlyFansCanComment,
    };

    const result = await wxDraftService.publishDraft(userId, dto);
    if ('error' in result) {
      res.sendFail(result.error, HttpStatus.ERROR);
      return;
    }
    res.sendSuccess(result.data, '草稿发布成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '草稿发布失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
