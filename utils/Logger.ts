// src/logger/Logger.ts
import winston, { Logger as WinstonLogger } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { getWorkerId } from './clusterConfig.ts';
import { LogConstants } from './constant/LogConstants.ts';

const logConfig = {
  rotate: LogConstants.ROTATE,
  datePattern: LogConstants.DATE_PATTERN,
  maxFiles: LogConstants.MAX_FILES,
};

/** worker 标识：cluster worker 返回其 id（兼容 NODE_APP_INSTANCE/pm2）；单进程/主进程为 primary */
const workerId = getWorkerId();

export class Logger {
  private static instance: WinstonLogger;

  public static getInstance(): WinstonLogger {
    if (!Logger.instance) {
      const logDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir);
      }

      const isProd = process.env.NODE_ENV === 'production';

      const { combine, timestamp, printf, colorize, json } = winston.format;

      const devFormat = printf(({ level, message, timestamp, ...meta }) => {
        return `${timestamp} [${level}] ${message} ${
          Object.keys(meta).length ? JSON.stringify(meta) : ''
        }`;
      });

      const fmt = combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        isProd ? json() : devFormat
      );

      // 多进程：所有 worker 共享同一按日期轮转的文件，靠 defaultMeta(workerId/pid) 区分来源进程。
      // 文件名含 %DATE%，轮转是打开新日期文件（不 rename 共享文件），跨进程追加写安全。
      const makeTransport = (filename: string, level?: string): winston.transport => {
        if (logConfig.rotate) {
          return new DailyRotateFile({
            dirname: logDir,
            filename: `${filename}-%DATE%`,
            extension: '.log',
            datePattern: logConfig.datePattern || 'YYYY-MM-DD',
            maxFiles: logConfig.maxFiles || '30d',
            ...(level ? { level } : {})
          });
        }
        return new winston.transports.File({
          filename: path.join(logDir, `${filename}.log`),
          ...(level ? { level } : {})
        });
      };

      Logger.instance = winston.createLogger({
        level: 'info',
        format: fmt,
        defaultMeta: { workerId, pid: process.pid },
        transports: [
          makeTransport('error', 'error'),
          makeTransport('app')
        ]
      });

      if (!isProd) {
        Logger.instance.add(
          new winston.transports.Console({
            format: combine(colorize(), devFormat)
          })
        );
      }
    }

    return Logger.instance;
  }
}
