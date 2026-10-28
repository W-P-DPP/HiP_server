# WxBot general-server

WxBot 平台的通用服务端。以 Node.js + Express 5 + TypeScript 为主体，对外提供用户/权限、
音色克隆、数字人视频合成、字幕生成、视频管道、微信公众号、抖音应用配置、MCP（Model Context
Protocol）等能力；GPU 推理（TTS / ASR / 对口型）全部拆分为独立的容器服务，通过 HTTP 或共享
目录与本服务协作。

- **HTTP 入口**：`/hip`（生产）/ `/dev/hip`（开发），见 `app.ts` 的 `prefix` 分支
- **默认端口**：`40010`（生产）/ `50010`（开发）
- **鉴权**：JWT（httpOnly Cookie 或 `Authorization: Bearer`）+ Redis 单点登录（同一账号新登录
  即让旧 token 失效）+ RSA 传输层密码加密
- **数据**：MongoDB（主，Mongoose）、Redis（缓存/租约/信号量）、MySQL（TypeORM，可选，当前启动流程未启用）

---

## 目录

- [功能全景](#功能全景)
- [技术栈](#技术栈)
- [架构设计](#架构设计)
- [项目结构](#项目结构)
- [本地开发](#本地开发)
- [环境变量](#环境变量)
- [生产部署教程](#生产部署教程)
- [运维与排障](#运维与排障)
- [常用命令](#常用命令)
- [测试](#测试)
- [编码约定](#编码约定)
- [相关文档](#相关文档)

---

## 功能全景

所有业务路由在 `src/index.ts` 注册，统一挂载于 `{prefix}/hip/api`（JWT 保护）。

| 模块 | 路由前缀 | 说明 |
|------|----------|------|
| 用户 | `/users` | 注册/登录（公开，`/hip/auth`）、资料、子用户树、批量建号、数据统计、角色（`user`/`admin`/`sadmin`） |
| 音色训练 V1 | `/voiceTrain` | 讯飞音色训练全流程：训练文本、建任务、提交音频、训练结果、RAASR 转写、合成 |
| 音色训练 V2 | `/voiceTrainV2` | 零样本音色克隆（IndexTTS2）：音色库（上传参考音、试听）、文本转语音合成任务与队列 |
| 数字人 | `/digitalHuman` | 形象库（参考视频归一化）+ HeyGem/duix 对口型合成任务，支持字幕烧录、取消、队列查询 |
| 字幕生成 | `/subtitles` | 音频/视频 → SRT（`/subtitles/tasks/from-media`：上传音频直接用，视频先 ffmpeg 提取音频）。ASR 通道 `auto`（本地 Whisper 优先 + 讯飞兜底）/ `xunfei` / `whisper` |
| 视频管道 V2 | `/videoPipelineV2` | IndexTTS 配音 + Whisper 字幕 → ffmpeg 烧录成片；含纯合成模式（复用已有音频/字幕） |
| 文件 | `/hip/api/files` | 上传（单/多）、列表、下载（免 JWT，见下）、假删除 |
| 定时任务 | `/scheduledTasks` | 定时任务 CRUD 与运行记录 |
| 任务运行记录 | `/taskRuns` | 任务运行流水 |
| Skill 市场 | `/skills` | Skill CRUD（含文件上传，key 为小写连字符唯一标识） |
| 订阅 | `/subscriptions` | 用户对 Skill 的订阅/取消/批量取消/校验 |
| Session | `/sessions` | UUID 签发登记（供 MCP 客户端会话鉴权） |
| 系统 | `/system` | 资源总览（CPU/内存/磁盘/GPU/进程）、版本、云端版本 |
| 微信公众号配置 | `/wxAccounts` | 按用户维护公众号凭证（AppID/AppSecret/Token/AESKey） |
| 抖音应用配置 | `/dyAccounts` | 按用户维护抖音开放平台凭证 |
| 视频素材库 | `/videoMaterials` | 素材上传与检索（Pexels / Pixabay 第三方素材 + 本地素材相似度匹配）；大文件走 `/videoMaterials/chunks/*` 分片上传 |
| 图片理解 | `/vlm` | 图片 → 结构化 JSON（Qwen3-VL-4B 4bit，独立容器）：`description`/`objects`/`actions`/`sceneType`/`tags`；亦可 `mode=text` 取自由描述。提交后轮询取结果 |
| AI 模型 | `/cmdc/models` | cmdc 平台可用模型列表 |

以下入口**不经** `/hip/api` 的 JWT 链：

| 入口 | 位置 | 说明 |
|------|------|------|
| 微信公众号公开回调 | `GET {prefix}/hip/wx` | 微信服务器签名校验，无 JWT（微信推送不带 token） |
| 微信公众号业务接口 | `{prefix}/hip/wx/{material,summary,draft,getToken}` | 需要 JWT，凭证按 `req.jwtPayload.id` 从 DB 读取 |
| 讯飞训练完成回调 | `ALL {prefix}/hip/api/voiceTrain/trainsCallback` | 公网可达、无 JWT。**必须注册在 JWT 挂载之前**，否则被 401 拦截 |
| 文件下载 | `GET {prefix}/hip/api/files/:id/download` | 免 JWT（MCP 客户端用会话 UUID，无法携带 JWT） |
| MCP | `{prefix}/hip/mcp` | Streamable HTTP（GET=SSE / POST=JSON-RPC / DELETE=关闭会话），会话 UUID 鉴权 |

**MCP 工具**（`mcp/`，在 `createMcpServer()` 中注册）：

| 工具 | 说明 |
|------|------|
| `add` | 连通性测试 |
| `publish_draft` | Markdown 发布为公众号草稿 |
| `add_material` | 新增公众号永久素材 |
| `digital_human` / `dh_queue` / `dh_status` | 提交数字人合成任务 / 查询排队位置 / 查询任务状态 |
| `video_pipeline_v2` / `vpv2_status` / `vpv2_queue` / `vpv2_queue_status` | 提交视频管道任务 / 查状态 / 查排队位置 / 查队列计数 |

已实现但在 `createMcpServer()` 中被注释掉、暂未对外暴露的还有：`generate_video`、`get_video_status`
（`mcp/autoVideo`）、`download_file`（`mcp/fileDownload`）、`get_published_content_data`
（`mcp/wx/freePublish`）。OAuth 2.0 授权服务器（`mcp/oauth/`）代码已就绪，但 `app.ts` 中
`buildOAuthAuthRouter()` 目前处于注释状态。

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js（ESM，`"type": "module"`，相对导入带 `.ts` 后缀） |
| 语言 | TypeScript 5.9（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`） |
| 构建 | Vite 7（SSR 打包为单文件 `dist/main.cjs`，`noExternal: true`） |
| Web 框架 | Express 5 |
| 进程模型 | `node:cluster`（`CLUSTER_WORKERS`，生产 10；未设置=单进程） |
| 数据库 | MongoDB（Mongoose 9，主）/ MySQL（TypeORM，可选） |
| 缓存 | Redis（会话、SSO token、leader 租约、全局信号量） |
| 认证 | JWT（`jsonwebtoken`）+ RSA（`keys/rsa_private.pem` 解前端密文密码）+ bcryptjs |
| MCP | `@modelcontextprotocol/sdk`（Streamable HTTP + OAuth） |
| AI | Vercel AI SDK（`ai` + `@ai-sdk/openai`）、cmdc 平台 |
| 媒体 | ffmpeg / ffprobe（视频合成、音频归一化、字幕烧录） |
| 日志 | Winston + winston-daily-rotate-file |
| 校验 | Zod |
| 测试 | Jest 29 + supertest + autocannon |
| 包管理 | pnpm 10（`packageManager: pnpm@10.13.1`） |

---

## 架构设计

### 启动流程

```
main.ts
 └─ import './utils/env.ts'          ← 副作用：加载 .env.${NODE_ENV}，固定 TZ；必须是首个 import
 └─ resolveWorkerCount()             ← CLUSTER_WORKERS：空/1/0/负数/非数字=1；'auto'=核数-2；N≥2=N
     ├─ cluster.isPrimary && >1 → startPrimary(n)   仅 fork + 生命周期管理，不连 DB、不 listen
     └─ 否则                    → startWorker()
          ├─ RedisService.connect() → MongoDBService.connect()   （MySQL initDataBase 当前注释）
          ├─ createApp() → listen(PORT) → process.send({ready})
          ├─ installShutdownHandlers()                           SIGTERM/SIGINT 优雅排空（8s 超时）
          └─ 按开关常驻启动调度器：indextts / digitalHuman / subtitle / videoPipelineV2
```

> 调度器**必须常驻**，不要绑到 `INDEXTTS_AUTOSTART` 之类的预热开关上：否则重启后队列里已有的
> `pending` 任务没有任何进程领取，会一直卡住，只能等下一次提交才被"撞开"。预热只影响模型加载。

### 中间件链（`app.ts`）

```
cors → express.json → urlencoded → bodyParser.text(text/xml)
  → RequestLogger → requestContext → responseMiddleware
  → {prefix}/hip/auth/*            （公开：注册/登录，RSA 解密中间件）
  → {prefix}/hip/api/voiceTrain/trainsCallback   （公开回调，须在 JWT 之前）
  → {prefix}/hip/api/files/*       （含免 JWT 的 download）
  → {prefix}/hip/api/*  → jwtMiddleware → router   （全部业务模块）
  → {prefix}/hip/mcp/*             （UUID 会话鉴权）
  → {prefix}/hip/wx                （公开签名回调）→ 同前缀下的业务接口 → jwtMiddleware
  → {prefix}/hip/*                 （express.static + serve-index 兜底前端）
  → ErrorLogger
```

响应统一为 `ResultVO<T>`：`{ code, msg, data, timestamp }`，由 `responseMiddleware` 注入
`res.sendSuccess(data, msg?)` / `res.sendFail(msg?, code?)`。

### 数据与任务模型

- **MongoDB 是唯一必连的存储**。实体统一 `interface I{Module} extends IBaseMongoEntity`，
  经 `BaseMongoPlugin` 注入 `createBy / updateBy / remark / flag / params`。
- **删除一律假删除**：`flag: 1` 未删除 / `0` 已删除，所有查询显式过滤 `flag: 1`，严禁物理删除。
- **Redis 的三种用途**：
  1. SSO 会话（`CacheConstants.SSO_TOKEN_KEY`，登出即删，使旧 token 立即失效）；
  2. **leader 租约**（`utils/leaderLease.ts`）—— 多 cluster worker 下全机只选出一个调度进程，
     避免同时抢 Mongo 队列、各写进度、各做恢复扫描；
  3. **全局信号量**（`utils/RedisSemaphore.ts`）—— 跨进程限制任务并发（例如视频合成）。
- **任务队列**：持久化在 Mongo（`pending/running/success/failed/cancelled`），由各模块的
  `*Dispatcher` 领取执行。中断恢复（`recoverStuckRunning`）把孤儿 `running` 任务重排回
  `pending`，同一任务最多重试 `TASK_MAX_ATTEMPTS = 3` 次，之后判 `failed`。
- **陈旧阈值（`*_TASK_STALE_MS`）必须大于「冷启动 + 单任务最长耗时」**，否则中断恢复会误杀
  正在跑的长任务。这是一类高频配置错误，改超时/并发时请连带复核。
- **视频转字幕的中间产物**：`POST /subtitles/tasks/from-media` 只在**视频**输入时才用 ffmpeg 把音轨
  提取成 `uploads/.subtitle/<uuid>/audio.wav`（16kHz 单声道，点号目录不经静态路由暴露，`file` 表也不登记）；
  音频输入直接用原文件。任务进入终态即删除临时音频；中断续跑会直接复用，只有它缺失时才从源视频重新提取。

### GPU 推理的边界

本服务**不做任何 CUDA 计算**。这些重活各自独立容器化，业务逻辑（队列、进度、文件落库、
归属校验）全部留在 Node 侧：

| 能力 | 服务 | 宿主回环端口 | 容器内地址 | 传输方式 |
|------|------|--------------|------------|----------|
| 音色克隆（IndexTTS2） | `services/indextts` | `127.0.0.1:39010` | `http://indextts-server:8000` | HTTP multipart |
| 字幕识别（Whisper large-v3） | `services/whisper` | `127.0.0.1:39020` | `http://whisper-server:8000` | HTTP multipart |
| 数字人对口型（duix/HeyGem） | `services/heygem` | `127.0.0.1:8383` | `http://duix-avatar-gen-video:8383` | **共享目录**（非 HTTP 上传） |
| 图片理解（Qwen3-VL-4B 4bit） | `services/vlm` | `127.0.0.1:39030` | `http://vlm-server:8000` | HTTP multipart |
| 场景切分（PySceneDetect，**纯 CPU**） | `services/scenedetect` | `127.0.0.1:39040` | `http://scenedetect-server:8000` | HTTP JSON |

五个 compose project 通过外部网络 `wxbot-gpu` 与 app 容器互通（scenedetect 纯 CPU，不占显存）；
四个 GPU 服务显存合计约 17.5GB
（IndexTTS 峰值 ~8GB + duix ~3.2GB + Whisper ~3GB + VLM **实测** ~3.3GB，单卡 20GB 场景）。

> ⚠️ **偏紧，但 VLM 那一块可以被让出来**：约 17.5GB / 20GB。它默认不预热
> （`VLM_EAGER_LOAD=false`）+ 空闲 10 分钟自动卸载（`VLM_IDLE_UNLOAD_MS=600000`），
> 闲置时显存回落到 ~0，用时才吃。注意这两个开关是两件事 —— 只关预热的话权重一旦加载就常驻不退。
> 详见 [`services/vlm/README.md`](./services/vlm/README.md) 的「显存生命周期」。

`INDEXTTS_MODE` 提供三种传输：`remote`（调 GPU 服务，**默认且推荐**）、`local`（本机 spawn
Python worker，回退用）、`off`（禁用，接口 503）。

---

## 项目结构

```
general_server/
├── main.ts / app.ts / eventRegister.ts      # 入口、Express 工厂、全局事件注册
├── vite.config.ts / tsconfig.json           # 构建与类型配置（别名 @ → src/*，# → mcp/*）
├── Dockerfile / docker-compose.yml          # 生产镜像与 app 编排
├── .env.development / .env.production       # 分环境变量（由 utils/env.ts 加载）
├── config.json / config copy.json           # 历史配置，当前代码未读取
├── src/                                     # 业务模块（六件套：entity/dto/repository/service/controller/router）
│   ├── index.ts                             # 路由汇总，挂载于 /hip/api
│   ├── user/ session/ system/ skill/ subscription/
│   ├── scheduledTask/ taskRun/ file/ model/
│   ├── voiceTrain/ voiceTrainV2/            # 讯飞训练 V1 / IndexTTS 克隆 V2
│   ├── digitalHuman/ subtitle/              # 对口型合成 / 音频转字幕
│   ├── videoPipelineV2/ videoMaterial/      # 视频管道 / 素材库
│   ├── aiDetect/ vlm/                       # 场景切分（PySceneDetect）/ 图片理解（Qwen3-VL）
│   └── wxAccount/ dyAccount/ oauthClient/
├── wx/                                      # 微信公众号（公开回调 + JWT 业务：material/summary/draft/signature）
├── mcp/                                     # MCP 服务端与工具（autoVideo/wx/digitalHuman/videoPipelineV2/oauth/...）
├── utils/                                   # 基础设施
│   ├── env.ts Redis.ts MongoDB.ts mysql.ts Axios.ts Logger.ts Singleton.ts
│   ├── clusterConfig.ts clusterPrimary.ts clusterWorker.ts gracefulExit.ts shutdownHooks.ts
│   ├── leaderLease.ts RedisSemaphore.ts AsyncQueue.ts requestContext.ts
│   ├── response.ts rsa.ts uuid.ts zip.ts mailer.ts md2html.ts parseXML.ts date.ts sleep.ts tools.ts
│   ├── indextts/ heygem/ whisper/ asr/ scenedetect/  # 外部推理服务的客户端与配置
│   ├── wx/ dy/ xunfei/ AIPlatform/ system/  # 各平台对接
│   ├── videoHelper/ videoPipelineV2/        # ffmpeg 与管道辅助
│   ├── constant/ entities/ middleware/ service/ types/
├── services/                                # 独立推理服务（各有自己的 compose 与 README）
│   ├── indextts/  whisper/  heygem/  vlm/
│   ├── scenedetect/                         # PySceneDetect（纯 CPU，独立 HTTP 容器）
├── public/                                  # 前端静态资源（front/、login/、icons/），由 /hip 提供
├── keys/                                    # RSA 私钥/公钥（gitignore 掉，部署时手工放置）
├── uploads/ logs/ .runtime/ data/           # 上传、日志、运行期产物
├── __tests__/                               # unit / integration / stress
└── docs/代码规范.md                          # 项目编码规范（新增代码前必读）
```

---

## 本地开发

### 环境要求

| 依赖 | 版本/说明 |
|------|-----------|
| Node.js | ≥ 20（Docker 镜像用 22-alpine） |
| pnpm | 10.x（`corepack` 或 `npm i -g pnpm@10.13.1`） |
| MongoDB | 必需 |
| Redis | 必需（JWT 启用时 SSO 强依赖） |
| ffmpeg / ffprobe | 视频合成、音频归一化必需（`ffmpeg -version` 可验证） |
| Python + GPU + Docker | **仅当需要本地跑音色克隆/字幕/数字人**，通常直接连 GPU 服务即可 |

### 步骤

```bash
# 1. 安装依赖
pnpm install

# 2. 准备环境变量：按机器实际情况修改 .env.development
#    （至少确认 MONGO_* / REDIS_* 可达；JWT_ENABLED=true 时还会校验 Redis 会话）

# 3. 放置 RSA 私钥（登录/注册依赖；缺失时接口会返回「服务端密码解密密钥不可用」）
#    私钥必须与前端 hip-front/src/constant/crypto.ts 的公钥成对
ls keys/rsa_private.pem

# 4. 启动
pnpm dev        # NODE_ENV=development，nodemon + tsx 热重载，监听 50010
```

开发态要点：

- 路由前缀是 `/dev/hip`，例如登录为 `POST http://localhost:50010/dev/hip/auth/login`。
- `CLUSTER_WORKERS` 不设置即单进程，方便断点调试。
- 若需要本地推理能力，见 `services/*/README.md`；不需要时保持 `INDEXTTS_MODE=remote` 并让
  `INDEXTTS_BASE_URL` 指向可达的 GPU 服务，或把对应 `*_ENABLED=false` 关掉。
- 数字人在开发机上**直接写宿主目录**（`HEYGEM_MOUNT_DIR=services/heygem/data`），因此只有 duix
  容器也挂在同一宿主目录时才能跑通；生产用的是命名卷 `wxbot-heygem-data`。

---

## 环境变量

由 `utils/env.ts` 在启动时从 `.env.${NODE_ENV}` 加载（`dotenv` **不覆盖**已存在的环境变量，
所以 `docker-compose.yml` 的 `environment` 优先级更高）。类型声明见 `utils/types/env.d.ts`。

### 核心必填

| 变量 | 说明 | 开发 | 生产 |
|------|------|------|------|
| `NODE_ENV` | `development` / `production` / `test` | development | production |
| `PORT` | 监听端口 | 50010 | 40010 |
| `TZ` | 进程时区，容器默认 UTC 必须显式设置 | Asia/Shanghai | Asia/Shanghai |
| `HIP_VERSION` | 版本号，`GET /system/version` 返回 | 1.2.2 | 1.2.2 |
| `SERVER_URL` | 公网可达 origin（无路径）；非 localhost 必须 https | http://localhost:50010 | https://<域名> |
| `MONGO_HOST/PORT/USER/PASSWORD/DATABASE` | MongoDB 连接（或直接用 `MONGO_URL`） | 127.0.0.1 | 远程库 |
| `MONGO_AUTH_SOURCE` | 认证库；远程按库鉴权时填库名 | 空 | HiP |
| `REDIS_HOST/PORT` | Redis 连接（或 `REDIS_URL`；`REDIS_PASSWORD` 存在则自动拼进 URL） | 127.0.0.1:6379 | 远程 |
| `JWT_ENABLED` | `true` 时强制校验；`false` 时仅 best-effort 解码 | true | true |
| `JWT_SECRET` | JWT 签名密钥 | 自定义 | **务必换强随机值** |
| `JWT_EXPIRES_IN` | token 有效期（秒） | 7200 | 7200 |
| `RSA_PRIVATE_KEY_PATH` | 密码解密私钥路径 | `./keys/rsa_private.pem` | `/app/keys/rsa_private.pem` |
| `CLUSTER_WORKERS` | `'auto'`=核数-2；N≥2=N；空/1=单进程 | 不设 | 10 |

### 功能开关与调参（按需）

| 分组 | 关键变量 |
|------|----------|
| 文件服务 | `FILE_UPLOAD_DIR`、`FILE_MAX_SIZE`、`FILE_ALLOWED_TYPES`、`FILE_STATIC_PREFIX` |
| 日志 | `LOG_ROTATE`、`LOG_DATE_PATTERN`、`LOG_MAX_FILES` |
| 操作日志 | `OPERATION_LOG_ENABLED`、`OPERATION_LOG_WHITELIST` |
| 邮件 | `MAILER_HOST/PORT/SECURE/USER/PASS`、`MAILER_FROM`、`MAILER_FROM_NAME`、`MAILER_ENABLED` |
| 微信 | `WX_APPID` `WX_AppSecret` `WX_EncodingAESKey` `WX_TOKEN`（业务凭证已迁移到 `wxAccounts` 集合按用户存储） |
| 讯飞 | `XUNFEI_APPID/APIKey/APISecret/TEXTID`、各 `XUNFEI_*_URL`、`XUNFEI_TRAIN_CALLBACK` |
| 第三方素材 | `PEXELS_API_KEY`、`PIXABAY_API_KEY`、`MATERIAL_MATCH_THRESHOLD` |
| 素材分片上传 | `VIDEO_MATERIAL_MAX_BYTES`、`VIDEO_MATERIAL_MAX_CHUNK_BYTES`、`VIDEO_MATERIAL_CHUNK_BYTES`、`VIDEO_MATERIAL_MAX_CHUNKS`、`VIDEO_MATERIAL_CHUNK_SESSION_TTL_MS` |
| AI 检测（场景切分） | `AI_DETECT_MAX_VIDEO_BYTES`（源视频上限，整份上传与分片合并同值，默认 2.5GB）、`AI_DETECT_CHUNK_MAX_CHUNK_BYTES`、`AI_DETECT_CHUNK_MAX_CHUNKS`、`AI_DETECT_CHUNK_SESSION_TTL_MS` |
| 音色克隆 | `INDEXTTS_MODE` `INDEXTTS_BASE_URL` `INDEXTTS_API_TOKEN` `INDEXTTS_ENABLED` `INDEXTTS_MAX_TEXT_CHARS` `INDEXTTS_JOB_TIMEOUT_MS` `INDEXTTS_TASK_STALE_MS` |
| 数字人 | `DIGITALHUMAN_ENABLED` `HEYGEM_BASE_URL` `HEYGEM_MOUNT_DIR` `HEYGEM_CONTAINER_PREFIX` `DIGITALHUMAN_CONCURRENCY` |
| 字幕 | `SUBTITLE_ENABLED` `ASR_PROVIDER` `ASR_LANGUAGE` `ASR_MAX_AUDIO_BYTES` `ASR_MAX_VIDEO_BYTES` `SUBTITLE_CONCURRENCY` |
| Whisper | `WHISPER_MODE` `WHISPER_BASE_URL` `WHISPER_API_TOKEN` `WHISPER_LANGUAGE` |
| 视频管道 | `VIDEO_PIPELINE_V2_ENABLED` `VIDEO_PIPELINE_V2_CONCURRENCY` `VIDEO_PIPELINE_V2_VOICE_TIMEOUT_MS` |
| AI 检测（场景切分） | `AI_DETECT_ENABLED` `AI_DETECT_MAX_VIDEO_BYTES` `AI_DETECT_CONCURRENCY` `AI_DETECT_TASK_STALE_MS` `AI_DETECT_BLACK_MIN_DURATION_SEC` `AI_DETECT_BLACK_PIC_TH` `AI_DETECT_BLACK_PIX_TH` |
| 图片理解 | `VLM_MODE` `VLM_BASE_URL` `VLM_API_TOKEN` `VLM_ENABLED` `VLM_MAX_IMAGE_BYTES` `VLM_CONCURRENCY` `VLM_JOB_TIMEOUT_MS` `VLM_TASK_STALE_MS` |
| 视频/ffmpeg | `FFMPEG_GPU`（off/auto/on）、`VIDEO_TASK_CONCURRENCY` |
| OAuth | `OAUTH_USER_ID` `OAUTH_ACCESS_TOKEN_TTL` `OAUTH_REFRESH_TOKEN_TTL` |

> ⚠️ **跨服务必须对齐的值**：
> `INDEXTTS_MAX_TEXT_CHARS` 要与 `services/indextts/docker-compose.yml` 的值一致；
> `INDEXTTS_API_TOKEN` 要与 `services/indextts/.env` 一致；
> `WHISPER_API_TOKEN` 要与 `services/whisper/.env` 一致；
> `VLM_API_TOKEN` 要与 `services/vlm/.env` 一致。
> 不一致会导致"提交时放行、执行时 400/401"的延迟失败。
>
> ⚠️ **超时链的单调性**：`DIGITALHUMAN_AUDIO_TIMEOUT_MS ≥ INDEXTTS_JOB_TIMEOUT_MS`、
> `DIGITALHUMAN_SUBTITLE_TIMEOUT_MS ≥ SUBTITLE_TASK_STALE_MS`、
> `VIDEO_PIPELINE_V2_VOICE_TIMEOUT_MS ≥ INDEXTTS_JOB_TIMEOUT_MS`、
> 以及各 `*_TASK_STALE_MS > 冷启动 + 单任务最长耗时`。
>
> 图片理解这条链要注意：`VLM_JOB_TIMEOUT_MS` 必须 ≥ 容器**冷加载模型**的耗时
> （`VLM_EAGER_LOAD=false` 时每个容器生命周期里的第一个任务都要等它把权重读进来），
> `VLM_TASK_STALE_MS` 再 ≥ `VLM_JOB_TIMEOUT_MS`。

---

## 生产部署教程

### 部署拓扑

```
                        ┌──────────────────────── Docker 网络 wxbot-gpu ───────────────────────┐
 公网/前端 ──► 宿主:40010 │  hip-server (app, dist/main.cjs, cluster=10)                      │
                        │      │              │              │               │              │
                        │      │ HTTP         │ HTTP         │ HTTP          │ 共享命名卷    │
                        │      ▼              ▼              ▼               ▼              │
                        │ whisper-server  indextts-server  vlm-server  duix-avatar-gen-video │
                        │ (:8000, GPU)    (:8000, GPU)    (:8000, GPU)  (:8383, GPU, priv.)  │
                        │ scenedetect-server (:8000, CPU)                                  │
                        └──────────────────────────────────────────────────────────────────┘
                             宿主回环 39020 / 39010 / 39030 / 8383 / 39040（仅开发机 Node 使用）
 外部依赖：MongoDB、Redis（可远程）、ffmpeg（已在镜像内）
```

本仓库包含 **6 个 compose project**（1 个 app + 4 个 GPU 服务 + 1 个 CPU 服务），互不依赖，可分别起停：

| 文件 | project 名 | 容器名 | 镜像 |
|------|------------|--------|------|
| `docker-compose.yml` | `HiP-server` | `hip-server` | 自建（`Dockerfile`） |
| `services/indextts/docker-compose.yml` | `indextts` | `indextts-server` | 自建 `indextts-server:2.0.0` |
| `services/whisper/docker-compose.yml` | `whisper` | `whisper-server` | 自建 `whisper-server:1.0.0` |
| `services/vlm/docker-compose.yml` | `vlm` | `vlm-server` | 自建 `vlm-server:1.0.0` |
| `services/scenedetect/docker-compose.yml` | `scenedetect` | `scenedetect-server` | 自建 `scenedetect-server:1.0.0`（纯 CPU） |
| `services/heygem/docker-compose.yml` | `heygem` | `duix-avatar-gen-video` | 上游预构建 `guiji2025/duix.avatar`（约 15GB） |

### 前置条件

1. **Docker + Docker Compose v2**，且已安装 NVIDIA 驱动与 `nvidia-container-toolkit`
   （`docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi` 能跑通）。
2. **一张 NVIDIA 显卡**（本方案按单卡 20GB 设计）。app 容器本身不占显存，但声明了
   `runtime: nvidia` + `NVIDIA_DRIVER_CAPABILITIES=utility`，只为了让 `nvidia-smi` 与
   `libnvidia-ml.so` 注入容器 —— 否则 `GET /hip/api/system/resources` 的 `gpu` 字段恒为空数组。
3. **宿主机目录/文件准备**：

   | 路径 | 用途 | 来源 |
   |------|------|------|
   | `./keys/rsa_private.pem` | 登录/注册密码解密（与前端公钥成对） | 运维放置，**不进仓库、不进镜像**，compose 只读挂载 |
   | `./uploads`、`./logs` | 上传与日志持久化 | 自动创建 |
   | `services/indextts/engine/` | IndexTTS2 源码 + 权重（约 22GB） | 按 `services/indextts/README.md` 安装 |
   | `services/whisper/engine/` | Whisper 宿主 venv（权重由容器首次自动下载到命名卷） | 按 `services/whisper/README.md` 安装 |
   | `services/vlm/engine/` | Qwen3-VL 宿主 venv（含 torch，数 GB；权重由容器首次自动下载到命名卷） | 按 `services/vlm/README.md` 安装 |
   | `services/indextts/.env`、`services/whisper/.env`、`services/vlm/.env`、`services/scenedetect/.env` | 各服务自己的 API Token | `cp .env.example .env && chmod 600 .env` |

   > `services/scenedetect` 是纯 CPU 服务，**无需准备宿主 venv**（Python 依赖直接装进镜像），
   > 也不需要 GPU。它把宿主 `./uploads` 只读挂进容器以便读取待检测视频。

4. **共享 Docker 网络**（app 与日志中的各推理服务都加入，必须预先存在，compose 里声明为 `external`）。

### 第 1 步：获取代码与密钥

```bash
git clone <repo-url> general_server && cd general_server

# RSA 私钥（务必与前端 hip-front/src/constant/crypto.ts 的公钥成对，轮换时两侧同步替换）
mkdir -p keys uploads logs
cp /path/to/rsa_private.pem keys/rsa_private.pem
chmod 600 keys/rsa_private.pem

# GPU 服务密钥
cd services/indextts && cp .env.example .env && chmod 600 .env && cd ../..
cd services/whisper  && cp .env.example .env && chmod 600 .env && cd ../..
cd services/vlm      && cp .env.example .env && chmod 600 .env && cd ../..
cd services/scenedetect && cp .env.example .env && chmod 600 .env && cd ../..
# 把 .env 里的 *API_TOKEN 与根 .env.production 的 INDEXTTS_API_TOKEN / WHISPER_API_TOKEN / VLM_API_TOKEN / SCENEDETECT_API_TOKEN 对齐
# （deploy.sh 会自动同步 scenedetect 的 token，上面的手工步骤只在使用 compose 直连时需要）
```

### 第 2 步：创建共享网络

```bash
docker network create wxbot-gpu    # 只需执行一次
```

### 第 3 步：启动推理服务（先于 app）

按需启动，GPU 服务首次启动都要加载模型（indextts 1–3 分钟，whisper 含权重下载可能更久）：

```bash
# 音色克隆（IndexTTS2）
cd services/indextts
docker compose up -d --build
curl -s localhost:39010/readyz        # 503 = 模型加载中，200 = 就绪

# 字幕识别（Whisper）
cd ../whisper
docker compose up -d --build
curl -s localhost:39020/readyz

# 图片理解（Qwen3-VL-4B 4bit）
cd ../vlm
docker compose up -d --build
# 健康检查探 /healthz（进程存活），几秒就绪 → 期望 healthy。
# 下面这个 /readyz 探的是「模型在不在位」：不预热（VLM_EAGER_LOAD=false）时**未用过就是 503**，
# 空闲卸载后也会回落 503 —— 都是预期。
curl -s localhost:39030/readyz

# 场景切分（PySceneDetect，纯 CPU，无需 GPU/宿主 venv）
cd ../scenedetect
cp .env.example .env && chmod 600 .env   # 首次：填 SCENEDETECT_API_TOKEN（与 .env.production 一致）
docker compose up -d --build
curl -s localhost:39040/healthz          # {"status":"ok"}

# 数字人对口型（duix/HeyGem，镜像约 15GB，首次拉取较久）
cd ../heygem
docker compose up -d
docker compose logs -f
```

注意事项：

- **`--workers 1` 是硬约束**（已在 compose 中固定）：进程内队列 + 单份热模型，多 worker 会各
  加载一份模型，显存翻倍。用 `/api/v1/status` 的 `load_count` 可以早期发现误配（>1 即异常）。
- **权重不进镜像**：`engine/` 只读挂载；IndexTTS 的 `INDEXTTS_ALLOW_DOWNLOAD=false`（缺失时给出
  可读清单而非在请求里静默下载数 GB），Whisper 默认 `true`（large-v3 约 3GB，落在命名卷）。
- **`services/indextts` 与 `services/whisper` 的 compose 全篇使用同一个 `${HOST_ROOT}`**，换机器时
  只需覆盖这一个环境变量（默认值是作者本机路径，务必按实际路径覆盖）。scenedetect 的 compose
  同样用 `${HOST_ROOT}` 挂载 uploads。
- **duix 与 app 共享命名卷 `wxbot-heygem-data`**，不要改回相对绑定挂载 —— 相对路径按各自 compose
  文件所在目录解析，两侧很容易落成不同宿主机目录，导致任务立刻报「三次获取音频时长失败」。
- 各服务都只把端口绑在宿主**回环**上；生产 app 在容器内，走共享网络按容器名访问。

### 第 4 步：配置 app 的生产变量与编排

```bash
# 1) 检查 .env.production：数据库、Redis、域名、密钥、各服务地址与开关
#    特别是 SERVER_URL、MONGO_*、REDIS_*、JWT_SECRET、XUNFEI_TRAIN_CALLBACK
#    RSA_PRIVATE_KEY_PATH 必须是容器内路径 /app/keys/rsa_private.pem

# 2) 检查 docker-compose.yml 的 environment 覆盖项（优先级高于镜像内 .env.production）
#    INDEXTTS_MODE=remote
#    INDEXTTS_BASE_URL=http://indextts-server:8000
#    SCENEDETECT_BASE_URL=http://scenedetect-server:8000
#    VLM_BASE_URL=http://vlm-server:8000
#    HEYGEM_BASE_URL=http://duix-avatar-gen-video:8383
#    HEYGEM_MOUNT_DIR=/app/services/heygem/data
#    HEYGEM_CONTAINER_PREFIX=/code/data
#    NVIDIA_VISIBLE_DEVICES=0 / NVIDIA_DRIVER_CAPABILITIES=utility
```

`.env.production` 会被打进镜像（`.dockerignore` 保留了它，其余 `.env*` 排除）。若不愿把密钥写进
镜像层，可改为在 `docker-compose.yml` 的 `environment` 中显式注入 —— `dotenv` 不会覆盖已存在的
环境变量，因此 compose 的值优先。

### 第 5 步：构建并启动 app

```bash
docker compose build          # 多阶段：pnpm install → vite build → 运行阶段仅生产依赖
docker compose up -d
docker compose logs -f app
docker compose ps             # 期望 hip-server 状态为 healthy（healthcheck 探测 HTTP 服务有响应）
```

镜像内的关键内容：`dist/main.cjs`（Vite SSR 单文件）、`public/`（前端静态资源）、
`.env.production`、`ffmpeg/ffprobe` + `font-noto-cjk`（字幕烧录需要 CJK 字体）、
`gcompat/libstdc++`（让 nvidia-container-toolkit 注入的 glibc 版 `nvidia-smi` 能在 Alpine 上执行）。

### 第 6 步：验证

```bash
# 1) 服务存活
curl -i http://localhost:40010/            # 无 / 路由，返回 404 即代表 HTTP 服务在响应

# 2) 登录（密码需按前端 RSA 公钥加密；这里用 curl 验证连通性时注意 400 也是"服务正常"的证据）
curl -s -X POST http://localhost:40010/hip/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"<账号>","password":"<RSA密文>"}'

# 3) 系统资源（需 JWT；gpu 字段非空说明 nvidia 运行时注入成功）
curl -s -H "Authorization: Bearer <token>" http://localhost:40010/hip/api/system/resources

# 4) 各引擎接线状态
curl -s -H "Authorization: Bearer <token>" http://localhost:40010/hip/api/voiceTrainV2/engine/status
curl -s -H "Authorization: Bearer <token>" http://localhost:40010/hip/api/subtitles/engine/status
curl -s -H "Authorization: Bearer <token>" http://localhost:40010/hip/api/digitalHuman/engine/status
curl -s -H "Authorization: Bearer <token>" http://localhost:40010/hip/api/videoPipelineV2/engine/status
# 图片理解：reachable=false 在未提交过任务时是**正常**的（容器不该预热），看 configured/leader 即可
curl -s -H "Authorization: Bearer <token>" http://localhost:40010/hip/api/vlm/engine/status

# 5) GPU 服务直连
curl -s localhost:39010/readyz
curl -s localhost:39020/readyz
curl -s localhost:39030/readyz

# 6) 字幕任务：/tasks 收音频（或 fileId）；/tasks/from-media 音频/视频通吃，视频会自动提取音频
curl -s -X POST "http://localhost:40010/hip/api/subtitles/tasks?userId=<userId>" \
  -F "file=@demo.mp3"                       # → { taskId, status: "pending" }
curl -s -X POST "http://localhost:40010/hip/api/subtitles/tasks/from-media?userId=<userId>" \
  -F "file=@demo.mp4"                       # 传 mp3 也可（等价于上一条，只是传输上限更宽）
curl -s "http://localhost:40010/hip/api/subtitles/tasks/<taskId>?userId=<userId>"   # 轮询进度，成功后取 srtUrl
# 直接失败（HTTP 400，不会建任务）：视频无音轨、视频解析失败、体积超限、类型无法识别
```

> `/engine/status` 是**回答该请求的那个 cluster worker 的进程内视角**。模型与 leader 租约全机只有
> 一份，因此非 leader worker 会如实返回 `leader=false`；`queueDepth` 来自 Mongo，是全局口径。

### 第 7 步：反向代理与前端

- 将域名（`SERVER_URL`）反代到 `127.0.0.1:40010`，并把 `/hip` 前缀透传（应用自身以 `/hip` 为根）。
- 前端静态资源由 app 提供：`public/front` → `{prefix}/hip`，`express.static` + `serve-index` 兜底。
  前端仓库构建产物需拷进 `public/front` 后重新构建镜像。
- 微信服务器需要公网可达 `GET {prefix}/hip/wx`，讯飞训练回调需要可达
  `{prefix}/hip/api/voiceTrain/trainsCallback`（两者都不带 JWT，故注册在 JWT 中间件之前）。
- **必须 HTTPS**（登录 Cookie 为 `httpOnly` + `sameSite=lax`；OAuth 授权服务器要求非 localhost 用 https）。

### 更新与回滚

```bash
git pull
docker compose build && docker compose up -d      # 滚动重启 app
# GPU 服务有改动时（compose 或桥接层代码）：
cd services/indextts && docker compose up -d --build
```

- app 重启时按 `SHUTDOWN_TIMEOUT_MS = 8s` 优雅排空（对齐 `docker stop` 的 10s 强杀）；超窗的长任务
  由下次启动的中断恢复重新入队，`attempts` 达上限才判失败。
- `services/indextts` 的 `stop_grace_period: 20s`：收到 SIGTERM 后 uvicorn 会拒绝新提交并把排队任务
  标记为 `interrupted`，CUDA 推理无法安全打断。

---

## 运维与排障

| 症状 | 排查方向 |
|------|----------|
| 登录/注册返回「服务端密码解密密钥不可用」 | 宿主 `./keys/rsa_private.pem` 缺失、路径不对（容器内应为 `/app/keys/rsa_private.pem`），或与前端公钥不成对 |
| 所有受保护接口 401「登录已失效或已在其他设备登录」 | 单点登录生效：Redis 中该用户的当前 token 与请求 token 不一致（同账号在别处登录过）。检查 Redis 可达与 `JWT_SECRET` 是否被改动 |
| `GET /system/resources` 的 `gpu` 恒为空数组 | app 容器缺少 nvidia 运行时注入：确认 compose 的 `runtime: nvidia`、`NVIDIA_DRIVER_CAPABILITIES=utility`，以及镜像内 `gcompat/libstdc++` 是否装上 |
| 数字人任务秒失败，报「三次获取音频时长失败」 | 头号故障源：app 与 duix 没挂同一份数据。必须都用命名卷 `wxbot-heygem-data`；`HEYGEM_MOUNT_DIR` 与 `HEYGEM_CONTAINER_PREFIX` 要分别对应"容器内挂载点"与"duix 内前缀" |
| 音色合成提交成功但任务变 `failed`（400） | `INDEXTTS_MAX_TEXT_CHARS` 两侧不一致：Node 侧比 GPU 服务侧宽松，超限文本提交时放行、执行时才被拒 |
| 音色/字幕接口 401 | `INDEXTTS_API_TOKEN` / `WHISPER_API_TOKEN` 与对应 `services/*/.env` 不一致 |
| 重启后队列里的 `pending` 任务不动 | 调度器未常驻：检查 `INDEXTTS_ENABLED` / `DIGITALHUMAN_ENABLED` / `SUBTITLE_ENABLED` / `VIDEO_PIPELINE_V2_ENABLED` / `AI_DETECT_ENABLED` / `VLM_ENABLED`，以及 Redis（leader 租约）是否可达 |
| 长任务被误判失败/重排 | 陈旧阈值过小：`*_TASK_STALE_MS` 必须大于「冷启动 + 单任务最长耗时」 |
| 模型加载了两份、显存爆 | GPU 服务被改成多 worker（`--workers` 必须为 1）。whisper/indextts 看 `/api/v1/status` 的 `load_count > 1`；**vlm 要减掉卸载次数**（`load_count - unload_count > 1`），否则会把正常的「空闲卸载后重载」误报成误配 |
| 容器反复 unhealthy / 被重启 | 冷启动窗口：indextts `start_period=600s`、whisper `900s`、duix `180s`；未就绪时 `/readyz` 故意返回 503。**vlm 例外**：它探 `/healthz`（进程存活，`start_period=60s`），因为它的 `/readyz` 会随懒加载/空闲卸载合法翻转，不能当健康检查用 |
| 字幕烧录中文变方框 | 镜像内字体缺失：`font-noto-cjk` 未安装（Alpine 无 Microsoft YaHei，libass 回退 Noto Sans CJK） |
| 队列积压但 GPU 空闲 | 检查 `*_ENABLED` 开关、`leader` 状态与 `concurrency`；`DIGITALHUMAN_CONCURRENCY=2` 的收益来自"配音与对口型的流水线重叠"，再往上不提高吞吐 |
| VLM `/readyz` 返回 503、`/vlm/engine/status` 的 `reachable=false` | **预期行为**：它表达的是「模型在不在位」，而不是「服务坏没坏」。未用过、或空闲 10 分钟后被自动卸载，都会是 503/false。容器健康检查另走 `/healthz`。要立刻拉起来打 `POST /api/v1/admin/warmup`；调度器不拿它当闸门（否则会「不加载就不领取」死锁） |
| 起 vlm 容器即 OOM，或四个 GPU 服务一起跑就爆显存 | 四者合计约 17.5GB / 20GB（VLM 常驻实测约 3.3GB），偏紧。VLM 平时不占（懒加载 + 空闲卸载），真的同时用起来才紧张。按收益顺序：压 `VLM_MAX_PIXELS`（视觉 token 头号杠杆）→ 降 `VLM_IDLE_UNLOAD_MS` 让它更快让出 → Whisper 降 `WHISPER_COMPUTE_TYPE=int8_float16` 或 `WHISPER_MODEL=medium` → 需要长期共存就上第二张卡。详见 `services/vlm/README.md` |
| VLM 显存一直不回落 / 或每个任务都要冷加载几十秒 | 前者：`VLM_IDLE_UNLOAD_MS=0`（卸载被关），或队列非空、有任务在跑；看 `/api/v1/status` 的 `idle_ms`、`queue`、`processing`。后者：调用间隔大于卸载阈值，若属常态就把 `VLM_IDLE_UNLOAD_MS` 设成 0 让它常驻 |
| 图片理解任务大量失败，message 带「未产出可解析的 JSON」 | 模型输出跑偏。message 里的原始输出片段是唯一线索；可加大容器侧 `VLM_MAX_NEW_TOKENS`，或调整 `VLM_DEFAULT_PROMPT` 收紧措辞 |
| 图片理解接口 401 | `VLM_API_TOKEN` 与 `services/vlm/.env` 不一致 |
| 图片理解任务失败，message 是 `fetch failed (ECONNREFUSED)` | vlm 容器没在跑。`docker compose ps` 若显示 `Created`，多半是 venv 建法不对（必须 `uv venv`，不能 `python3 -m venv`）—— `docker inspect vlm-server` 会看到 `exec: "python": executable file not found in $PATH`。详见 `services/vlm/README.md` 的「安装」 |
| 图片理解提交即 503 | `VLM_ENABLED=false`，或 `VLM_MODE` 不是 `remote` / `VLM_BASE_URL` 为空（未配置时在**提交**就拦掉，不给你一个注定失败的 taskId） |

查看日志：

```bash
docker compose logs -f app                 # 应用日志（同时写 ./logs，按天切分）
docker compose logs -f --tail=200 app
cd services/indextts && docker compose logs -f
```

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 开发启动（`NODE_ENV=development`，nodemon + tsx 热重载） |
| `pnpm build` | 生产构建（Vite SSR → `dist/main.cjs`） |
| `pnpm start` | 生产启动（`NODE_ENV=production`，运行 `dist/main.cjs`） |
| `pnpm test` / `test:unit` / `test:integration` / `test:coverage` | 测试与覆盖率 |
| `pnpm stress` / `stress:spike` / `stress:soak` | autocannon 压测 |

部署相关：

| 命令 | 说明 |
|------|------|
| `docker network create wxbot-gpu` | 仅首次，创建 app 与 GPU 服务共享的网络 |
| `docker compose build && docker compose up -d` | 构建并启动 app |
| `cd services/indextts && docker compose up -d --build` | 构建并启动 IndexTTS GPU 服务 |
| `cd services/whisper && docker compose up -d --build` | 构建并启动 Whisper GPU 服务 |
| `cd services/vlm && docker compose up -d --build` | 构建并启动 Qwen3-VL 图片理解服务 |
| `cd services/scenedetect && docker compose up -d --build` | 构建并启动 PySceneDetect 场景切分服务（纯 CPU） |
| `cd services/heygem && docker compose up -d` | 启动 duix 数字人服务 |
| `curl -s localhost:39010/readyz` / `:39020/readyz` | 就绪探针（模型加载完成前 503） |
| `curl -s localhost:39030/readyz` | VLM 就绪探针（`VLM_EAGER_LOAD=false` 时未提交任务前恒 503，属预期） |
| `curl -s localhost:39040/healthz` | scenedetect 存活探针（恒 200；它无模型加载） |

---

## 测试

```
__tests__/
├── setup.ts            # 全局 setup（jest.config.cjs 的 setupFiles）
├── unit/               # 单元测试（*.test.ts，当前用例集中于此）
└── stress/             # autocannon 压测脚本（run.ts）
```

- 运行方式：`pnpm test` / `pnpm test:unit` / `pnpm test:integration` / `pnpm test:coverage`
  （`test:integration` 脚本对应 `__tests__/integration`，该目录当前不存在）
- 基于 `ts-jest` ESM preset，别名 `@/* → src/*`，测试环境自动 `NODE_ENV=test`
- 用例描述统一中文，例如 `'应生成有效的 JWT token'`

---

## 编码约定

完整规范见 [`docs/代码规范.md`](./docs/代码规范.md)（新增/修改代码前必读）。核心几条：

1. **模块六件套**：`{module}.{entity|dto|repository|service|controller|router}.ts`，新增后到
   `src/index.ts` 注册 `router.use('/{module}s', {module}Router)`。
2. **职责边界**：controller 只做解析/校验/响应，service 编排业务，repository 是唯一数据库访问点。
   禁止 controller 直接 import 其他模块的 repository。
3. **假删除**：删除一律 `flag: 0`，查询一律带 `flag: 1`，严禁物理删除。
4. **类型声明收敛**：新增类型统一放 `type/index.d.ts`（namespace 方式）；环境变量类型放
   `utils/types/env.d.ts`。
5. **响应规范**：`res.sendSuccess(data, msg?)` / `res.sendFail(msg?, code?)`，错误码取 `HttpStatus`。
6. **路由路径**：`/api/{module}s`（复数小写），业务提示信息统一中文。
7. **Git 提交**：`<type>: <中文描述>`，type ∈ `feat|fix|docs|del|refactor|perf|test|chore`。

---

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/代码规范.md`](./docs/代码规范.md) | 项目编码规范（命名、分层、实体、测试、提交） |
| [`services/indextts/README.md`](./services/indextts/README.md) | IndexTTS2 推理侧：stdio/HTTP 双协议、权重、显存、部署 |
| [`services/whisper/README.md`](./services/whisper/README.md) | Whisper ASR 服务：HTTP 契约、SRT 切分规则、部署 |
| [`services/heygem/README.md`](./services/heygem/README.md) | duix/HeyGem 数字人：共享目录机制、接口、并发 |
| [`services/vlm/README.md`](./services/vlm/README.md) | Qwen3-VL 图片理解：HTTP 契约、结构化 JSON 的三层保障、权重与显存 |
| [`services/scenedetect/README.md`](./services/scenedetect/README.md) | PySceneDetect 场景切分：独立 CPU 容器、HTTP 契约、uploads 挂载、remote/local 双形态 |
| [`CLAUDE.md`](./CLAUDE.md) | AI 辅助编码时的项目速查（架构与命令摘要） |

---

## 部署前安全清单

- `JWT_SECRET` **必须**替换为强随机值；`.env.production` 当前含明文数据库/Redis 密码与第三方
  API Key，且被 Git 跟踪 —— 建议迁出仓库改为运行时注入，并轮换已泄露的凭证。
- RSA 私钥仅存在于宿主机 `./keys`（已 gitignore、已 dockerignore），只读挂载进容器。
- `services/indextts/.env`、`services/whisper/.env` 不入库，仅提交 `.env.example`。
- duix 容器需要 `privileged: true`（上游镜像的硬要求），部署时请限制其网络暴露面
  （只绑宿主回环，仅经 `wxbot-gpu` 与 app 互通）。

## 觉得有用的话可以请我喝杯咖啡
![收款码](public/8b3044cf1c02c5a207208fbd552516a0.jpg)