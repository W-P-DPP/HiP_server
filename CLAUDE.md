# WxBot - 通用服务端项目

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js (ESM, `"type": "module"`) |
| 语言 | TypeScript 5.9 (`strict` 模式) |
| 构建 | Vite 7 |
| Web 框架 | Express 5 |
| ORM | TypeORM (MySQL) |
| ODM | Mongoose (MongoDB) |
| 缓存 | Redis (redis 库) |
| 认证 | JWT (`jsonwebtoken`) |
| 日志 | Winston + winston-daily-rotate-file |
| 验证 | Zod (配合 AI SDK) |
| AI | Vercel AI SDK (`ai` + `@ai-sdk/openai`) |
| 测试 | Jest 29 + supertest + autocannon |
| 包管理 | pnpm 10 |

## 项目结构

```
general-server/
├── main.ts              # 启动入口：加载 env → 连接服务 → 启动 HTTP
├── app.ts               # Express app 工厂函数，组装中间件链
├── vite.config.ts       # 生产构建配置
├── src/
│   ├── index.ts         # 路由入口 (/api 前缀)
│   ├── siteMenu/        # 站点菜单模块
│   └── operationLog/    # 操作日志实体
├── utils/
│   ├── index.ts         # 工具模块 barrel export（首个 import 加载 .env）
│   ├── env.ts           # .env 加载副作用（main.ts 首个 import）
│   ├── MongoDB.ts       # MongoDB 连接服务（单例）
│   ├── Redis.ts         # Redis 连接服务（单例）
│   ├── mysql.ts         # MySQL/TypeORM 初始化
│   ├── Axios.ts         # Axios 请求服务（单例）
│   ├── Logger.ts        # Winston 日志器（单例）
│   ├── Singleton.ts     # 抽象单例基类
│   ├── mailer.ts        # Nodemailer 邮件服务
│   ├── response.ts      # success() / fail() 响应工具
│   ├── middleware/
│   │   ├── jwtMiddleware.ts      # JWT 鉴权（可通过 JWT_ENABLED 开关）
│   │   ├── responseMiddleware.ts # 注入 res.sendSuccess / res.sendFail
│   │   └── operationLogMiddleware.ts
│   ├── ai/
│   │   └── classifier.ts         # AI 分类器（Vercel AI SDK）
│   ├── constant/         # HttpStatus, CacheConstants
│   └── types/            # .d.ts 类型声明
├── .env.development      # 开发环境变量
├── .env.production       # 生产环境变量
└── __tests__/            # 单元/集成/压力测试
```

## 核心架构模式

### 启动流程 (main.ts)

```
utils/env.ts（main.ts 首个 import）→ 加载 .env.{NODE_ENV}
  → initRedis() / MongoDBService.connect() / initDataBase() 按需初始化
  → createApp() 组装 Express 中间件链
  → app.listen(PORT)
```

### 服务单例模式

所有外部连接服务（Redis、MongoDB、Axios、Logger）均采用单例：

```ts
class XxxService {
  private static instance: XxxService;
  public static getInstance(): XxxService { ... }
}
```

新增服务时遵循此模式，参考 `utils/MongoDB.ts` 或 `utils/Redis.ts`。

### 中间件链 (app.ts)

```
cors → express.json → urlencoded → bodyParser.text(xml)
  → RequestLogger → responseMiddleware
  → /api/* → jwtMiddleware → operationLogMiddleware → router
  → ErrorLogger
```

- `responseMiddleware` 在所有路由前注入 `res.sendSuccess(data, msg?)` 和 `res.sendFail(msg?, code?)`
- JWT 可通过环境变量 `JWT_ENABLED=false` 关闭（开发环境默认关闭）
- 路由统一挂载在 `/api` 前缀下

### 配置管理

- 环境变量由 `utils/env.ts` 在启动时加载进 `process.env`，消费方直接读 `process.env.X`（带默认值）
- 类型声明在 `utils/types/env.d.ts`（`NodeJS.ProcessEnv`）
- 开发环境变量在 `.env.development`，生产环境在 `.env.production`

### IndexTTS 音色克隆：独立 GPU 服务

音色克隆（IndexTTS2）的推理已与 Node 业务解耦，跑在独立的 Docker GPU 服务里
（`services/indextts/`，见其 `README.md`）。一份热模型同时服务开发与生产。

```
dev: node（宿主）    ─┐
                      ├─HTTP→ indextts-server 容器（uvicorn，GPU 并发=1）
prod: hip-server 容器 ─┘        唯一热模型 ~7.8GB，权重只读挂载
```

- Node 侧由 `INDEXTTS_MODE` 切换传输：`remote`（调 GPU 服务，**默认且推荐**）、
  `local`（本机 spawn，回退用）、`off`（禁用，接口 503）
- 切换点是 `utils/indextts/indexttsEngineFactory.ts` 的 `getIndexttsEngine()`：
  返回 `IndexttsHttpClient` 或 `IndexttsWorker`，两者实现同一个
  `utils/indextts/IndexttsEngine.ts` 契约，因此 `indexttsDispatcher` 与调度逻辑不受影响
- **Mongo 任务队列与调度器仍在 Node 侧**：容器只做「文本 + 参考音字节 → wav 字节」，
  不含业务逻辑，也不连数据库
- 生产 Node 经共享 Docker 网络 `wxbot-gpu` 按容器名访问（`http://indextts-server:8000`）；
  开发机走宿主回环 `127.0.0.1:39010`
- 所有 `INDEXTTS_AUTOSTART` 必须保持 `false`：本机 22GB 引擎目录仍在，置 true 会在 Node
  启动时又拉起本地热模型，与容器抢显存

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 开发模式启动（NODE_ENV=development，nodemon 热重载） |
| `pnpm build` | 生产构建（Vite） |
| `pnpm start` | 生产启动（NODE_ENV=production） |
| `pnpm test` | 运行全部测试 |
| `pnpm test:unit` | 运行单元测试 |
| `pnpm test:integration` | 运行集成测试 |
| `pnpm test:coverage` | 测试覆盖率 |
| `pnpm stress` | 运行压力测试 |

IndexTTS GPU 服务（独立 compose project，与上面无关）：

| 命令 | 说明 |
|------|------|
| `docker network create wxbot-gpu` | 仅首次：创建 app 与 GPU 服务共享的网络 |
| `cd services/indextts && docker compose up -d --build` | 构建并启动 GPU 服务 |
| `cd services/indextts && docker compose logs -f` | 跟踪推理日志 |
| `curl -s localhost:39010/readyz` | 就绪探针（模型加载完成前返回 503） |

## 编码约定

### 新增路由模块

1. 在 `src/` 下创建 `{moduleName}/{moduleName}.controller.ts`
2. 在 `src/index.ts` 中注册路由
3. 需要鉴权的路由统一挂载在 `/api` 下，自动经过 JWT + 操作日志中间件

### 新增数据库实体

- **MySQL**: 在 `src/` 下创建 `{name}.entity.ts`，TypeORM 会自动扫描 `src/**/*.entity.ts`
- **MongoDB**: 使用 `MongoDBService.getInstance().getMongoose()` 获取 mongoose 实例，定义 Schema/Model

### 响应规范

统一使用 `ResultVO<T>` 格式：

```ts
// 成功
res.sendSuccess(data, '操作成功');
// 失败
res.sendFail('错误信息', 400);
```

### TypeScript 规则

- `verbatimModuleSyntax: true` — import 语句必须保留原始语法
- `noUncheckedIndexedAccess: true` — 索引访问必须处理 undefined
- 路径别名 `@/*` → `src/*`
- 环境变量类型声明在 `utils/types/env.d.ts`
