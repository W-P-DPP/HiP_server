import type { Request, Response } from 'express';
import { listModels } from '../../utils/AIPlatform/cmdc/ListModel.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** GET /hip/api/models — cmdc 平台支持的模型列表（JWT 由 /hip/api 级 jwtMiddleware 统一保护） */
export const getModels = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await listModels();
    res.sendSuccess(data, '查询成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '模型列表查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
