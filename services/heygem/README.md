# HeyGem / duix 数字人（对口型）服务

数字人视频合成的推理侧。给定**驱动音频**与**形象参考视频**，产出对口型的成片。

本服务**只做一件事**：音频 + 参考视频 → mp4。任务队列、进度状态机、文件落库、归属校验
全部在 Node 侧（`src/digitalHuman/`），本目录只有编排与文档。

与 `services/indextts` 同构（同样的独立 compose project + 共享 GPU 网络），区别有两点：

| | `services/indextts` | `services/heygem` |
|---|---|---|
| 镜像 | 自建（`Dockerfile`，复用宿主 venv） | 上游预构建 `guiji2025/duix.avatar`（约 15GB） |
| 取素材方式 | HTTP 上传（multipart） | **共享目录**：duix 只读挂载目录内的文件 |

| 文件 | 作用 |
|------|------|
| `docker-compose.yml` | 独立 deploy：容器、GPU、回环端口、共享卷 |
| `data/` | 历史遗留目录（改用命名卷 `wxbot-heygem-data` 后不再使用，可忽略） |

## 共享目录是头号故障源

duix 容器**不接收 HTTP 上传**。Node 侧（`utils/heygem/HeygemClient.ts`）把素材拷进挂载目录，
上行的是**容器内路径**：

```
Node 写入   卷内 tasks/<code>/audio.wav   + model.mp4
上行路径     /code/data/tasks/<code>/audio.wav                   + model.mp4
产物回收     卷内 temp/<code>-r.mp4
```

两个 compose project 通过**全局命名卷 `wxbot-heygem-data`** 共享同一份数据：

| 环境 | `HEYGEM_MOUNT_DIR` | 由谁挂载 |
|------|--------------------|----------|
| 开发（`pnpm dev`，Node 在宿主上） | `services/heygem/data` | 无 —— Node 直接写宿主路径（仅 dev 用） |
| 生产（Node 在容器内） | `/app/services/heygem/data` | 根 `docker-compose.yml` 的 `wxbot-heygem-data:/app/services/heygem/data` |
| duix 容器 | — | 本 compose 的 `wxbot-heygem-data:/code/data` |

> **为什么用命名卷而不是 `./data` 绑定挂载**：绑定挂载按各自 compose 文件所在目录解析。
> 生产 app 由 Jenkins 部署（`/var/lib/jenkins/workspace/HiP_server/services/heygem/data`），
> 若 duix 从另一处检出启动（开发目录等），两边就是**不同宿主机目录** —— Node 写入的
> `audio.wav` 对 duix 不可见，任务在 0.4s 内立刻失败并报 `三次获取音频时长失败`
> （duix 内部 ffprobe 取不到流信息，重试 3 次后放弃）。命名卷与检出位置无关，从根上消除该坑。
>
> 若沿用绑定挂载，则必须保证两份 compose 从**同一检出目录**启动，别无他法。

## 起停

```bash
docker network create wxbot-gpu      # 仅首次；app 容器也加入此网络
cd services/heygem
docker compose up -d
docker compose logs -f               # 上游服务的日志
```

重建（改了 compose 或要换挂载）：

```bash
cd services/heygem
docker compose up -d --force-recreate
```

> 若容器此前由**别的 compose project** 创建（例如 JY_IPAgent），`container_name` 会冲突。
> 先 `docker rm -f duix-avatar-gen-video` 再 `up`，让本目录接管。

## 端口与网络

- 宿主只绑回环 `127.0.0.1:8383`，供开发机上的 Node 进程访问。
- 容器同时加入共享网络 `wxbot-gpu`，生产 Node 容器按容器名直连
  `http://duix-avatar-gen-video:8383`（见 `.env.production` 的 `HEYGEM_BASE_URL`）。
- 因此 `wxbot-gpu` 必须已存在，且 app 容器也在其中。

## 接口（上游 FastAPI/Flask，8383）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/easy/submit` | JSON：`code` + `audio_url` + `video_url`（**容器内路径**），可选 `chaofen` / `watermark_switch` / `pn` |
| GET | `/easy/query?code=<code>` | 状态：`status`（0 排队 / 1 合成中 / 2 完成 / 3 失败）、`progress`、`result` |

Node 侧的客户端封装在 `utils/heygem/HeygemClient.ts`：stage 素材 → submit → 轮询 query
（同时扫 `temp/`、`result/` 兜住「上游已清理索引但产物已落盘」的情况）→ 回收产物并校验
moov 原子与体积，避免拿到 ffmpeg 写了一半的文件。

## 性能与并发

- **单实例串行**：上游进程内单任务队列，GPU 上下文唯一。Node 侧的 leader 租约
  （`utils/leaderLease.ts`）保证全机只有一个调度进程投递，见 `src/digitalHuman/digitalHumanDispatcher.ts`。
- **Node 侧并发**：`DIGITALHUMAN_CONCURRENCY`（代码默认 1，本仓库 `.env` 取 2）控制调度器的
  在途任务数。duix 依旧串行，收益来自**流水线重叠** —— 一条任务在 indexTTS 上配音时，另一条
  在 duix 上对口型，两个 GPU 服务互不阻塞。再往上只增加等待中的任务，不提高吞吐。
- **实测**：十几秒的驱动音频 ≈ 数秒到数十秒出片（`HEYGEM_TIMEOUT_SEC=3600` 有极大余量）。
- **显存**：duix 约 3.2GB，与 IndexTTS（峰值约 8GB）共用一张 20GB 卡，余量充足。

## 相关配置（Node 侧）

| 变量 | 位置 | 说明 |
|------|------|------|
| `HEYGEM_BASE_URL` | `.env.*` / 根 compose | duix 地址 |
| `HEYGEM_MOUNT_DIR` | `.env.*` | Node 可见的共享卷挂载点（容器内为 `/app/services/heygem/data`） |
| `HEYGEM_CONTAINER_PREFIX` | `.env.*` | 容器内前缀，默认 `/code/data` |
| `HEYGEM_CHAOFEN` / `HEYGEM_WATERMARK` / `HEYGEM_PN` | `.env.*` | 透传上游的提交参数 |
| `HEYGEM_TIMEOUT_SEC` / `HEYGEM_MAX_CRASHES` | `.env.*` | 单任务超时 / 连续失败熔断阈值 |
| `DIGITALHUMAN_CONCURRENCY` | `.env.*` | 调度器在途任务数上限（默认 1） |
