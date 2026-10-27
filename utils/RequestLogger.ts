// src/logger/RequestLogger.ts
import morgan from 'morgan';
import type { Request, Response } from 'express';
import { Logger } from './Logger.ts';

export class RequestLogger {
  private static logger = Logger.getInstance();

  public static middleware() {
    morgan.token('body', (req: Request) =>
      JSON.stringify(req.body || {})
    );

    return morgan(
      ':method :url :status :res[content-length] - :response-time ms :body',
      {
        stream: {
          write: (message: string) => {
            RequestLogger.logger.info(message.trim());
          }
        }
      }
    );
  }
}
