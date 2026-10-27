import mongoose, { type Connection } from 'mongoose';
import { Logger } from './index.ts';

class MongoDBService {
  private static instance: MongoDBService;
  private connection: Connection | null = null;
  private logger = Logger.getInstance();

  private constructor() {}

  /** 获取单例 */
  public static getInstance(): MongoDBService {
    if (!MongoDBService.instance) {
      MongoDBService.instance = new MongoDBService();
    }
    return MongoDBService.instance;
  }

  /** 构建连接 URI */
  private buildUri(): string {
    if (process.env.MONGO_URL) {
      return process.env.MONGO_URL;
    }

    const user = process.env.MONGO_USER;
    const password = process.env.MONGO_PASSWORD;
    const host = process.env.MONGO_HOST;
    const port = process.env.MONGO_PORT;
    const database = process.env.MONGO_DATABASE;
    const authSource = process.env.MONGO_AUTH_SOURCE;
    const credentials = user && password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : '';
    const base = `mongodb://${credentials}${host}:${port}/${database}`;
    const params = new URLSearchParams();
    if (authSource) params.set('authSource', authSource);
    console.log(params.toString() ? `${base}?${params.toString()}` : base)
    return params.toString() ? `${base}?${params.toString()}` : base;
  }

  /** 连接 MongoDB */
  public async connect(): Promise<Connection> {
    if (this.connection && this.connection.readyState === 1) {
      return this.connection;
    }

    const uri = this.buildUri();
    this.logger.info(`[MongoDB] connecting to ${uri.replace(/\/\/.*@/, '//<credentials>@')}`);

    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
        heartbeatFrequencyMS: 10000,
      });

      this.connection = mongoose.connection;

      this.connection.on('error', (err) => {
        this.logger.error(`[MongoDB] error: ${err}`);
      });

      this.connection.on('disconnected', () => {
        this.logger.warn('[MongoDB] disconnected');
      });

      this.logger.info('[MongoDB] connected');
      return this.connection;
    } catch (err) {
      this.logger.error(`[MongoDB] connection failed: ${err}`);
      throw err;
    }
  }

  /** 获取原生 Connection 对象 */
  public getConnection(): Connection | null {
    return this.connection;
  }

  /** 获取 mongoose 实例 */
  public getMongoose(): typeof mongoose {
    return mongoose;
  }

  /** 断开连接 */
  public async disconnect(): Promise<void> {
    if (this.connection) {
      await mongoose.disconnect();
      this.connection = null;
      this.logger.info('[MongoDB] disconnected');
    }
  }
}

export default MongoDBService;
