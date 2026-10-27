import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Logger } from './index.ts';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export default async function initDataBase() {
    const logger = Logger.getInstance();
    logger.info('Initializing MySQL Database Connection...');
    dataSource = new DataSource({
        type: (process.env.DB_TYPE as 'mysql') || 'mysql',
        host:  process.env.DB_HOST || '127.0.0.1',
        port:  parseInt(process.env.DB_PORT || '3306', 10),
        username:  process.env.DB_USER || 'root',
        password:  process.env.DB_PASSWORD || 'password',
        database:  process.env.DB_NAME || 'wxbot',
        connectorPackage: 'mysql2',
        synchronize: true, // 生产环境一定 false
        logging: ['error'],
        timezone: process.env.DB_TIMEZONE || '+08:00',
        charset:process.env.DB_CHARSET || 'utf8mb4',

        entities: ['src/**/*.entity.ts'],
        migrations: ['src/**/*.migration.ts']
    });
    return dataSource.initialize();
};
