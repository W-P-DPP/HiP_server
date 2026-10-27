# Whisper ASR 服务

字幕生成（`src/subtitle/`）的**本地优先识别通道**：ASR 链路是「本地 Whisper 优先 + 云端讯飞
兜底」（`utils/asr/index.ts` 的 `auto` 链）。本目录即优先通道的实现 —— 音频字节 → SRT 文本。
自有 GPU、快且不计费，因此排在最前；本服务不可用时由讯飞接手，不会把任务卡死。

| 文件 | 作用 |
|------|------|
| `whisper_engine.py` | 模型加载、转写、SRT 生成（不含任何业务逻辑） |
| `run_whisper.py` | 宿主验证 CLI（docker 之前先确认 venv / 权重 / GPU） |
| `http/settings.py` | 配置（全部来自环境变量） |
| `http/jobs.py` | 作业模型与注册表（内存 + JSONL，容器重启后可解释中断） |
| `http/server.py` | FastAPI 应用，实现下面的 HTTP 契约 |
| `Dockerfile` `docker-compose.yml` | 独立 GPU 服务的构建与编排 |
| `engine/` | 宿主 venv（+ CLI 用的权重缓存），**不进仓库**，见 `.gitignore` |

## 为什么必须是独立服务

生产运行镜像是 `node:22-alpine`（见根 `Dockerfile`），**不含 Python**，也没有 GPU 运行时。
本地 Whisper 只能作为独立容器部署，通过 HTTP 与业务服务通信 —— 与 `services/indextts/`
（IndexTTS2）、`services/heygem/`（HeyGem/Duix）同一套编排方式。

本服务是**无状态**的：不挂载业务目录，唯一持久化的是自管 state 卷（上传音频 + SRT 产物 +
job 注册表 + 权重缓存）。因此可以直接搬到另一台 GPU 机器。

## 模型与显存

默认 `large-v3` + `cuda` + `float16`，**约 3GB 显存**，中文准确率最好。

本机（单张 ~20GB 卡）与其它服务共存：duix ≈3.2GB + IndexTTS ≈8GB + Whisper ≈3GB ≈ 14GB。
若显存吃紧，按序考虑：`WHISPER_COMPUTE_TYPE=int8_float16` → `WHISPER_MODEL=medium` →
`WHISPER_DEVICE=cpu`（此时建议同时 `WHISPER_COMPUTE_TYPE=int8`）。

首次启动会从 `hf-mirror.com` 拉取权重（`large-v3` 约 3GB），落在命名卷 `whisper-state`
的 `models/` 下，**只下载一次**。离线环境把 `WHISPER_ALLOW_DOWNLOAD=false`，届时缺失会给出
**可读的缺失清单**，而不是在用户请求里静默拉几个 GB。

> 与 indextts 的默认值不同（那边 `ALLOW_DOWNLOAD=false`）：IndexTTS 权重 14GB 且为 B 站
> 自定义许可；Whisper large-v3 约 3GB、MIT，首次自动拉取更实用。

## HTTP 契约

所有 `/api/v1/*` 端点需 `Authorization: Bearer <WHISPER_API_TOKEN>`（`/readyz`、`/healthz` 无鉴权）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 存活探针，恒 200，不碰 GPU |
| GET | `/readyz` | 就绪 200 / 模型加载中 503。**无鉴权**，Node 侧 `ready()` 依赖此语义 |
| GET | `/api/v1/status` | 模型、设备、`load_count`、GPU 显存、队列深度、当前 job、权重落地情况 |
| POST | `/api/v1/jobs` | multipart：`audio`(File) + `language` + `client_job_id` → 202 `{job_id}` |
| GET | `/api/v1/jobs/{id}` | `{job_id, state, progress, stage, error?}` |
| GET | `/api/v1/jobs/{id}/result` | `text/plain; charset=utf-8` 的 **SRT 文本** |
| DELETE | `/api/v1/jobs/{id}` | 取消 queued（running → 409，推理无法安全打断） |
| POST | `/api/v1/admin/warmup` | 幂等触发模型加载 |

**错误语义**（决定 Node 侧是否计熔断）：音频为空/过小 → `400`；超过 `WHISPER_MAX_UPLOAD_MB`
→ `413`；队列满 → `429`；服务停机中 → `503`；job 不存在 → `404`。Node 侧把 4xx 视为
「本条任务失败」（`clientFault`，不计熔断），5xx 才计入。

**`language`**：`zh` / `en` / … 直接透传；`auto`、`autodialect`、留空 → 自动检测
（Node 侧 `ASR_LANGUAGE` 默认就是讯飞口径的 `autodialect`）。

**`client_job_id`**：幂等键，Node 侧传 Mongo taskId。重投（提交响应丢失、429 退避重试、
中断任务续跑）不会重复消耗 GPU。刻意**不过滤终态** —— 真正要挡的正是「原任务已跑完但响应丢了」
的重试。

**stage key**（ASCII，仅随 `stage` 字段展示，与 Node 侧 stage 词表无耦合）：
`whisper_load` / `whisper_ready` / `whisper_transcribe` / `whisper_done`。

**SRT 生成**：每个 Whisper segment 再按字幕规则二次切分（时间按字数比例分配），
时间戳为 `HH:MM:SS,mmm`。切分规则（`whisper_engine.split_long_text`）是**严格按标点、产物不带标点**：

1. **每个标点都是断点** —— 句末（。！？…；）与句读（，、：）一视同仁，即
   「一条字幕 = 两个标点之间的一段话」（`在A客户三个月上线，在B客户拖了一年。` → 两条）；
2. **标点只决定切点，不进产物** —— 输出前统一丢弃；`1,000` / `http://a.b/c` 里**夹在数字/字母
   之间**的半角符号不视为标点，既不断句也不丢（`_is_break` 的词内判定）；
3. 整段**一个标点都没有**时，才在 `WHISPER_MAX_CHARS_PER_CUE`（默认 20）处硬切兜底，
   否则无标点长串会顶满整屏；有标点时该上限不生效（规则 1 优先）；
4. 不替模型补标点：模型没吐标点时，那条 cue 只能按停顿/上限切；
5. 归一化（半角→全角，仅中文相邻）只是让第 1、2 条的判定与展示一致，产物里同样不会保留。

空结果会被判为失败（`未识别到有效字幕`）。

## 宿主验证（docker 之前）

先排除 venv / 权重 / GPU 三类问题：

```bash
cd services/whisper
uv venv --python 3.10 engine/.venv
uv pip install --python engine/.venv/bin/python -r requirements.txt

# 首次会从 hf-mirror 下载 large-v3（约 3GB）
engine/.venv/bin/python run_whisper.py --audio /path/to/中文音频.mp3 --language zh --out /tmp/a.srt
```

期望：stderr 打印 `weights={...}` 与进度，`/tmp/a.srt` 为合法 SRT；`nvidia-smi` 可见约 3GB 占用。
`run_whisper.py` 的权重落在 `engine/models`，与容器的命名卷**互不共享**（各下一份）。

## 容器化部署

```bash
docker network create wxbot-gpu          # 仅首次；app 容器也加入此网络
cd services/whisper
cp .env.example .env && chmod 600 .env   # 填 WHISPER_API_TOKEN（与 Node 侧一致）
docker compose up -d --build
```

要点：

- **权重不进镜像**：`engine/` 含宿主 venv，由 compose **只读**挂载；镜像只 COPY 桥接层源码
  （`Dockerfile.dockerignore` 把 `engine/` 排除出构建上下文）。
- **CUDA 运行库来自 pip，不依赖基础镜像**：IndexTTS 的 torch 轮子自带 cuDNN/cuBLAS，而
  faster-whisper 依赖的 CTranslate2 **不自带**。这里由 `requirements.txt` 装
  `nvidia-cublas-cu12` / `nvidia-cudnn-cu12`（落在宿主 venv 里，随之被挂进容器），
  再由 `whisper_engine.preload_cuda_libraries()` 以 `RTLD_GLOBAL` 预加载。
  因此基础镜像沿用与 indextts 相同的 `-base-` 即可，**不需要** `-cudnn-runtime-`。
- **`HF_HUB_DISABLE_XET=1` 是必须的**：hf-mirror 没有代理 Xet 的 CAS 存储
  （`cas-server.xethub.hf.co`），走 Xet 会 `401 Unauthorized` 导致权重下载整体失败。
- **venv 必须由 uv 创建**：uv 会把解释器放在 `~/.local/share/uv/python/<triple>/`，compose 把
  该目录按**逐字相同路径**挂进容器，venv 的符号链接才不会断。用系统 `python3 -m venv` 建出来的
  venv 指向 `/usr/bin/python3.12`，容器内没有该路径，直接不可用。
  本机 uv 已装好 `cpython-3.10.21`，故用 `--python 3.10`（faster-whisper 支持 3.9+）。
- **`--workers 1` 是硬约束**：进程内队列 + 单份热模型。`/api/v1/status` 的 `load_count`
  用于尽早发现误配（>1 即异常）。
- 端口绑宿主回环 `127.0.0.1:39020`；生产 Node 在容器内，经共享网络用
  `http://whisper-server:8000`。
- healthcheck 的 `start_period` 为 900s，覆盖首次权重下载。

手工验证：

```bash
T=$(grep WHISPER_API_TOKEN .env | cut -d= -f2)
curl -s localhost:39020/readyz | jq
curl -s -H "Authorization: Bearer $T" localhost:39020/api/v1/status | jq '.model,.device,.load_count,.gpu'
J=$(curl -s -H "Authorization: Bearer $T" \
      -F 'audio=@/path/to/中文音频.mp3' -F 'language=zh' -F 'client_job_id=demo-1' \
      localhost:39020/api/v1/jobs | jq -r .job_id)
curl -s -H "Authorization: Bearer $T" localhost:39020/api/v1/jobs/$J | jq '.state,.progress,.cue_count'
curl -s -H "Authorization: Bearer $T" localhost:39020/api/v1/jobs/$J/result   # SRT 文本
```

## Node 侧对接

| 位置 | 作用 |
|---|---|
| `utils/whisper/whisper.config.ts` | 读取 `WHISPER_MODE` / `WHISPER_BASE_URL` / `WHISPER_API_TOKEN` / 超时与轮询间隔 |
| `utils/whisper/WhisperHttpClient.ts` | 上述契约的客户端（原生 `fetch`/`FormData`/`File`） |
| `utils/asr/whisperProvider.ts` | 把客户端包装成 `AsrProvider` |
| `utils/asr/index.ts` | `auto` 链：讯飞失败后降级到本通道 |

启用方式（部署本服务并确认可达后）：

```
WHISPER_MODE=remote
WHISPER_BASE_URL=http://127.0.0.1:39020      # 生产：http://whisper-server:8000
WHISPER_API_TOKEN=<与服务端一致>
```

`ASR_PROVIDER` 保持 `auto`（本地 Whisper 优先、不可用时降级讯飞）；排障时可临时设为 `whisper`
强制只走本通道（或设为 `xunfei` 绕开本服务）。`WHISPER_MODE=off` 时 `auto` 链不会包含本通道。
`GET /api/subtitles/engine/status` 的 `whisper.enabled` / `whisper.reachable` 可用于确认接线是否生效。
