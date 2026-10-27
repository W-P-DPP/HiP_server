import dotenv from 'dotenv';
import path from 'path';

// 必须在任何业务模块之前加载 .env：
// ESM 的 import 会在 main.ts 主体执行前完成，若只在 bootstrap() 里加载，
// 模块顶层读取 process.env 的代码（如各单例 getInstance() 的构造函数）会拿到 undefined。
// 通过 main.ts 的首个 import 副作用保证本模块最早求值。
dotenv.config({ path: path.resolve(process.cwd(), `.env.${process.env.NODE_ENV || 'development'}`) });

// 固定进程时区为北京时间（默认）：Docker 容器默认 UTC，若不固定，
// new Date() 的本地表示、dayjs().format()、无时区字符串日期解析都会偏 8 小时。
// 注意：MongoDB 存储的 BSON Date 本身是 UTC 绝对时间戳，不受此影响（也不应改）。
process.env.TZ = process.env.TZ || 'Asia/Shanghai';
