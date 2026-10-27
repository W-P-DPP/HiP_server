# scenedetect — PySceneDetect 场景切分（独立 CPU 服务）

把视频按「镜头 / 场景」切分为若干时间段。**纯 CPU**，不需要 GPU。

场景切分恒走**独立 HTTP 容器**（与 `services/vlm`、`services/whisper` 同构）：Node 侧
`utils/videoHelper/sceneDetect.ts` 只把视频的绝对路径发过来，检测在本容器内完成。

## 为什么必须独立起容器

app 运行镜像是 `node:22-alpine`（musl），而 `opencv-python-headless` 在 PyPI 上**只有 manylinux(glibc)
轮子**（已验证：没有 musllinux）——装不进 app 镜像；宿主 glibc venv 也无法挂进 musl 容器。
所以检测跑在独立的 `python:3.12-slim` 容器里，依赖**装进镜像**，app 通过 HTTP 调用。

```
Node (utils/scenedetect/ScenedetectHttpClient.ts / utils/videoHelper/sceneDetect.ts)
   │  POST /api/v1/detect   { input: "<视频绝对路径>", detector?, threshold?, ... }
   ▼
scenedetect-server:8000（FastAPI + PySceneDetect，纯 CPU）
   ▼
同构 JSON：{ ok, version, detector, frameRate, durationMs, sceneCount, scenes:[...] }
```

## 部署（生产，独立容器）

与 vlm/whisper 同一个模式：独立的 compose project、共享外部网络 `wxbot-gpu`、端口只绑宿主回环。

```bash
docker network create wxbot-gpu            # 仅首次
cd services/scenedetect
cp .env.example .env && chmod 600 .env     # 填 SCENEDETECT_API_TOKEN（须与 app 侧一致）
docker compose up -d --build
docker compose ps                          # 期望 healthy：健康检查探 /healthz
curl -s localhost:39040/healthz            # {"status":"ok"}
```

- 宿主回环端口 **39040**（indextts 39010 / whisper 39020 / vlm 39030 之后的下一号）。
- 生产 app 容器内走共享网络访问：`SCENEDETECT_BASE_URL=http://scenedetect-server:8000`。
- 由 `../../deploy.sh` 统一构建/启动/校验（容器名 `scenedetect-server`）。

### ⚠️ 视频路径：uploads 双挂载

Node 侧会把**视频的绝对路径**原样发来，而该路径是 app 进程里 `FILE_UPLOAD_DIR`（=`./uploads`）的绝对化结果：

| 部署形态 | app 进程里的路径 |
|---|---|
| 生产 | app 跑在容器里，`cwd=/app` ⇒ `/app/uploads/...`（宿主 `./uploads` 已挂进 app） |
| 开发 | app 跑在宿主，`cwd=仓库根` ⇒ `<仓库>/uploads/...` |

所以本服务的 compose 把**同一份宿主 uploads** 同时挂到这两个绝对路径（只读）：

```yaml
volumes:
  - ${HOST_ROOT}/uploads:/app/uploads:ro
  - ${HOST_ROOT}/uploads:${HOST_ROOT}/uploads:ro
```

> 若 app 的 `FILE_UPLOAD_DIR` 改成非 `./uploads` 的绝对路径，需同步调整这里的挂载目标。

## HTTP 契约

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/healthz` | 无 | 恒 200（进程存活）。**compose 健康检查与部署校验探它** |
| GET | `/readyz` | 无 | 恒 200（本服务无模型加载，就绪即存活） |
| POST | `/api/v1/detect` | Bearer | JSON 入参 → 与检测脚本 stdout 同构的 JSON 出参 |

请求体（snake_case；未给的字段省略，交回脚本缺省值）：

```json
{ "input": "/app/uploads/2026/10/15/xxx.mp4", "detector": "content",
  "threshold": 27, "min_scene_len": 0.6, "downscale": 2, "frame_skip": 0 }
```

| 字段 | 缺省 | 说明 |
|---|---|---|
| `input` | 必填 | 视频的绝对路径（须落在本服务可见的挂载目录内） |
| `detector` | `content` | `content` 内容突变（通用默认）/ `adaptive` 自适应（快镜头、运动多）/ `threshold` 亮度阈值（淡入淡出、黑白） |
| `threshold` | 按算法 | 各算法推荐值：content 27 / adaptive 3 / threshold 12。越小越敏感、切得越多 |
| `min_scene_len` | `0.6` | 最短场景时长（秒）；脚本内部按帧率换算成帧数（检测器的原生单位是帧） |
| `downscale` | 自动 | 检测前降采样倍数。缺省交给 PySceneDetect 按分辨率自适应；大分辨率视频显式给 `2`/`3` 可显著提速 |
| `frame_skip` | `0` | 隔帧采样数，越大越快越粗 |

**检测本身失败返回 200 + `{"ok":false,"error":...}`**；只有入参不合法（缺 `input` / 路径不存在 /
目录越界 / 未知算法）才 400，鉴权失败 401。Node 侧按 `ok !== true` 统一抛 `场景检测失败：<error>`。

出参（毫秒为单位）：

```json
{"ok": true, "version": "0.6.6", "detector": "content", "threshold": 27.0,
 "minSceneLenSec": 0.6, "frameRate": 10.0, "durationMs": 9000, "sceneCount": 3,
 "scenes": [{"index": 1, "startMs": 0, "endMs": 3000, "durationMs": 3000},
            {"index": 2, "startMs": 3000, "endMs": 6000, "durationMs": 3000},
            {"index": 3, "startMs": 6000, "endMs": 9000, "durationMs": 3000}]}
```

其它环境变量（`services/scenedetect/docker-compose.yml` 的 `environment` 里配）：

| 键 | 默认 | 说明 |
|---|---|---|
| `SCENEDETECT_API_TOKEN` | 空 | Bearer token；空 = 不鉴权（仅限回环/内网）。在 `.env` 里配 |
| `SCENEDETECT_MAX_CONCURRENCY` | `1` | 同时检测数上限。纯 CPU 逐帧分析，并发只会互相拖慢 |
| `SCENEDETECT_ALLOWED_ROOT` | 空 | 只允许检测该目录下的视频；留空不限 |

## Node 侧（恒走 HTTP 容器）

`utils/constant/scenedetect.ts` 只读两个环境变量：

- `SCENEDETECT_BASE_URL`：本服务地址。**未配置即视为未启用**（提交检测时报「场景检测服务未配置」）。
- `SCENEDETECT_API_TOKEN`（可选）：须与本容器的 `SCENEDETECT_API_TOKEN` 一致，否则 401。

HTTP 请求超时走 Node 侧 `SCENEDETECT_TIMEOUT_MS`（默认 10 分钟），必须小于 `AI_DETECT_TASK_STALE_MS`。

## 约定

- 出参 JSON 单行（诊断信息走 stderr），Node 侧直接 `JSON.parse`。
- 失败时同样输出 JSON（`ok: false` + `error`），Node 侧不依赖退出码判错。
- 结果**无缝覆盖整段视频**：`start_in_scene=True` 保证首个切点之前的那一段不被丢弃；无切点时返回整段单一场景。
- 时间单位统一 **毫秒**（`startMs` / `endMs` / `durationMs`），与项目内 `SrtCue` 一致。
