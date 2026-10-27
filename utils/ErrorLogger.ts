// src/logger/ErrorLogger.ts
import type { Request, Response, NextFunction } from 'express';
import { Logger } from './Logger.ts';

export class ErrorLogger {
  private static logger = Logger.getInstance();

  public static middleware() {
    return (
      err: Error,
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      ErrorLogger.logger.error({
        message: err.message,
        stack: err.stack,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip
      });

      res.status(500).json({
        message: 'Internal Server Error'
      });
    };
  }
}
