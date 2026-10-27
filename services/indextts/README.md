# IndexTTS2 推理侧

音色克隆（零样本）的推理实现。有**两条传输**，共用同一套推理执行体（`job_runner.py`）：

| 传输 | 谁在用 | 入口 |
|------|--------|------|
| stdio | Node 侧 `INDEXTTS_MODE=local` —— 由 `utils/indextts/IndexttsWorker.ts` 以子进程拉起 | `indextts_worker.py` |
| HTTP | Node 侧 `INDEXTTS_MODE=remote` —— 独立部署的 GPU 服务容器 | `http/server.py` |

> `INDEXTTS_MODE=remote` 是**推荐**部署方式：一份热模型同时服务开发与生产，开发机不需要
> 引擎、venv 与 Python 侧的 GPU 依赖。`local` 保留用于回退。

移植自 `JY_IPAgent` 的 `tts/` 相关实现，按服务端场景做了裁剪。

| 文件 | 作用 |
|------|------|
| `job_runner.py` | **共用执行体**：文案解析、参考音校验、调用推理。两条传输都走这里 |
| `indextts_engine.py` | 模型加载与推理（与 IndexTTS2 内部对接的部分尽量与上游保持 1:1） |
| `indextts_worker.py` | 常驻 worker：加载一次模型，之后通过 stdio 逐行 JSON 收发任务 |
| `run_indextts.py` | 一次性子进程兜底（worker 关闭或反复崩溃时使用，每次重新加载模型） |
| `progress.py` | `@@PROGRESS@@` 进度协议；`add_sink()` 让 HTTP 模式复用同一套进度回调 |
| `http/` | FastAPI 服务（`settings.py` / `jobs.py` / `server.py`）—— 独立 GPU 服务的实现 |
| `Dockerfile` `docker-compose.yml` | 独立 GPU 服务的构建与编排 |

## 与上游 JY_IPAgent 的差异

1. **去掉自动 `pip install`**：上游 worker 启动时会联网装 `pyyaml`，生产环境不允许这种副作用，改为启动前校验并给出可操作的报错。
2. **配置改 JSON**：stdio 模式由 Node 生成 `indextts.config.json`（见 `utils/indextts/indextts.config.ts`）；HTTP 模式由 `http/settings.py` 从环境变量生成同名结构。两种方式都让 Python 侧除模型自带的 `config.yaml` 解析外不再依赖 PyYAML，也不再需要 `presets.yaml` / `config.yaml`。
3. **只保留 clone 模式**：参考音路径由调用方给绝对路径，不再有 preset / dialect / english 分支，也不需要 `resolve_speak_emo_spk`。
4. **不产出 dubbing timing**：那是视频/字幕管线的产物，本服务只做「文本 → 音频」。
5. **stderr 与 stdout 分离**：上游把 stderr 并入 stdout 再逐行 `json.loads`，杂散 traceback 会污染协议。这里 stdout 是纯 JSON 通道，日志一律走 stderr。

## 协议（stdio）

一行 JSON 进，若干 `@@PROGRESS@@` 行 + 一行 JSON 出：

```
启动  → @@PROGRESS@@ … 然后 {"ready": true, "backend": "indextts2-worker"}
任务  → stdout: {"text"|"text_file", "output", "reference", "speed"}
        stdout: @@PROGRESS@@ <pct> <stage> [seg=a/b] [audio=n]
        stdout: {"ok": true, "raw_audio": "<abs>"}
            或 {"ok": false, "error": "...", "trace": "..."}
ping  → {"pong": true}
退出  → shutdown → {"shutdown": true}
```

`stage` 只用 ASCII key（`config` / `indextts_load` / `indextts_ready` / `indextts_synth` / `indextts_done`），
中文标签在 Node 侧 `utils/constant/indextts.ts` 映射。HTTP 模式沿用**完全相同**的 stage key，
因此前端与 `indexttsStageLabel` 一行都不用改。

## 协议（HTTP）

`/healthz`、`/readyz` 免鉴权（供容器 healthcheck）；`/api/v1/*` 要求
`Authorization: Bearer $INDEXTTS_API_TOKEN`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 存活，恒 200，不碰 GPU |
| GET | `/readyz` | 就绪 200 / 模型加载中 503，body 含 `loading/stage/pct/queue` |
| GET | `/api/v1/status` | 模型、`load_count`、GPU、队列深度、当前 job、权重完整性 |
| POST | `/api/v1/jobs` | multipart（`text`、`speed`、`reference`、`client_job_id`）→ 202 |
| GET | `/api/v1/jobs/{id}` | 状态与进度（`state/progress/stage/segCur/segTotal/audioSec`） |
| GET | `/api/v1/jobs/{id}/result` | wav 二进制 |
| DELETE | `/api/v1/jobs/{id}` | 取消排队中的 job（running → 409，CUDA 推理无法安全打断） |
| POST | `/api/v1/admin/warmup` | 幂等触发模型加载 |

**异步 job + 轮询**：合成动辄数分钟，任何 HTTP 请求都不承载推理时长。`client_job_id`
是幂等键（Node 侧传 Mongo taskId），重投不会重复消耗 GPU。

**文本长度上限**：`INDEXTTS_MAX_TEXT_CHARS`，超限时 `POST /api/v1/jobs` 直接 400
（`http/server.py` 的校验）。当前部署值 **5000**，写在 `docker-compose.yml` 的 `environment` 里
—— 改 `services/indextts/.env` **不生效**（compose 的 `environment` 优先级高于 `env_file`）。
Python 代码里的兜底默认是 1000，只在没有 compose 注入时才用到。

⚠️ 这个值在 **Node 侧另有一道同名独立校验**（`utils/indextts/indextts.config.ts` 的
`maxTextChars`，值来自 `.env.development` / `.env.production` 的 `INDEXTTS_MAX_TEXT_CHARS`）。
**两侧必须一致**：Node 侧更宽松时，超限文本会在提交时放行、调度到这里才被拒，任务变 `failed`，
用户白等一轮。

引擎本身**不限制**文本长度 —— `indextts_engine.py` 会按 speed 预设
（fast/balanced/quality = 80/72/140 token）把文本内部分段、逐段合成、段间插静音拼接，
并带完整性校验与缩小分段重试。这个上限只决定「单条任务要占用唯一那块 GPU 多久」，
因此调大它时要一并检查 Node 侧的 `INDEXTTS_JOB_TIMEOUT_MS` 与 `INDEXTTS_TASK_STALE_MS`。

手工验证：

```bash
T=$(grep INDEXTTS_API_TOKEN .env | cut -d= -f2)
curl -s localhost:39010/readyz | jq
curl -s -H "Authorization: Bearer $T" localhost:39010/api/v1/status | jq '.load_count, .gpu'
curl -s -H "Authorization: Bearer $T" \
  -F 'text=这是一段试听文本' -F 'speed=balanced' -F 'client_job_id=demo-1' \
  -F 'reference=@/path/to/ref.wav' \
  localhost:39010/api/v1/jobs
# → {"job_id":"…"}；随后 GET /api/v1/jobs/<id> 轮询，成功后 GET …/result 取 wav
```

## 容器化部署（推荐）

```bash
docker network create wxbot-gpu          # 仅首次；app 容器也加入此网络
cd services/indextts
cp .env.example .env && chmod 600 .env   # 填 INDEXTTS_API_TOKEN
docker compose up -d --build
```

要点：

- **权重不进镜像**：`engine/checkpoints`（约 14GB）由 compose **只读**挂载。IndexTTS2 为
  B 站自定义许可，再分发受限，这样做同时也避开了该问题。
- **`--workers 1` 是硬约束**：进程内队列 + 单份热模型。多 worker 会各加载一份 7.8GB 模型。
  `/api/v1/status` 的 `load_count` 用于尽早发现这种误配（>1 即异常）。
- **只读权重要求 `prepare_indextts_cfg` 支持 `out_dir`**：生成的 `config.agent.yaml`
  写到可写的 state 卷，而非权重目录（否则 `EROFS`）。
- 冷启动 1–3 分钟，healthcheck 的 `start_period` 设为 600s，避免期间被反复重启。
- 端口绑宿主回环 `127.0.0.1:39010`；生产 Node 在容器内，经共享网络用
  `http://indextts-server:8000`。

## 权重与引擎

`engine/` 目录（IndexTTS2 检出 + 权重）约 **22GB**，已加入 `.gitignore`：

```bash
cd services/indextts
git clone https://github.com/index-tts/index-tts.git engine
cd engine && uv sync            # 或按上游 README 建 venv 并安装依赖
# 权重放到 engine/checkpoints/（gpt.pth / s2mel.pth / feat1.pt / feat2.pt /
#   wav2vec2bert_stats.pt / bpe.model，以及 hf_cache/ 与 qwen0.6bemo4-merge/）
```

默认 `INDEXTTS_ALLOW_DOWNLOAD=false`：worker 只做完整性检查，缺文件时抛出**可读的缺失清单**，
不会在用户请求里悄悄触发数 GB 下载。确认网络与磁盘后设 `true` 可自动补齐（优先 ModelScope，
回退 hf-mirror）。

依赖由 `engine/uv.lock` 冻结，容器镜像用 `uv sync --frozen --extra webui` 还原；
`webui` extra 顺带带来 fastapi/uvicorn/pydantic/python-multipart，因此 HTTP 服务
无需额外的依赖清单。

## 显存

FP16 下约 6–8 GB。`INDEXTTS_USE_FP16=false` 基本装不下，请勿关闭。

**全机只允许一个热模型**。改成独立 GPU 服务后，这条约束由「容器天然单实例」保证；
Node 侧的 Redis 租约（`utils/indextts/IndexttsLeaderLease.ts`）语义随之变为
「全机只选出一个调度进程」，不再是防 OOM 的那道闸。详见
`src/voiceTrainV2/indexttsDispatcher.ts`。

与 duix 数字人容器共用一张 20GB 卡：duix 约 3.2GB + IndexTTS 峰值约 8GB ≈ 11–12GB，余量充足。
