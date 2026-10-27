import type { Request, Response } from 'express';
import { systemService } from './system.service.ts';
import { HttpStatus } from '../../utils/constant/HttpStatus.ts';

/** GET /hip/api/system/resources — 系统资源总览（JWT 由 /hip/api 级 jwtMiddleware 统一保护） */
export const getSystemResources = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await systemService.getResources();
    res.sendSuccess(data, '查询成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '系统资源查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
/** GET /hip/api/system/version — 获取系统版本 */
export const getVersion = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await systemService.getVersion();
    res.sendSuccess(data, '查询成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '系统版本查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
/** GET /hip/api/system/cloudVersion — 获取系统版本-云端 */
export const getCloudVersion = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await systemService.getCloudVersion();
    res.sendSuccess(data, '查询成功');
  } catch (err) {
    const message = err instanceof Error ? err.message : '系统版本查询失败';
    res.sendFail(message, HttpStatus.ERROR);
  }
};
