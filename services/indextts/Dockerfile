# syntax=docker/dockerfile:1.7
#
# 独立 IndexTTS GPU 推理服务。
#
# 构建上下文是**仓库根**（见 docker-compose.yml 的 context: ../..），
# 配套的 services/indextts/Dockerfile.dockerignore 会剔除 22GB 引擎目录，
# 实测上下文仅约 70KB。
#
# ============================ 依赖策略 ============================
# 本镜像**复用宿主已有的 services/indextts/engine/.venv**，不在镜像内安装 Python 依赖。
#
# 为什么不用 `uv sync --frozen` 在镜像内重建依赖（更"标准"的做法）：
#   构建机到 ghcr.io / download.pytorch.org 的国际带宽极差 —— 实测拉取 23MB 的 uv 官方
#   镜像就卡死在 17.8MB，而 torch cu128 及其 CUDA 依赖约 3GB，镜像内安装基本不可行。
#   宿主 engine/.venv 已是一份**可用、且与本地验证环境完全一致**的依赖集（由 uv.lock 冻结，
#   含 torch 2.8 cu128、fastapi、uvicorn、python-multipart），直接复用既零下载，
#   又彻底消除了版本漂移。
#
# 代价：镜像不自包含，运行时必须挂载宿主目录，且**容器内路径须与宿主完全一致** ——
#   venv 里的 python 是指向 uv Python 的符号链接、bin/* 的 shebang 也是绝对路径，
#   换路径就会断链。挂载由 docker-compose.yml 负责（HOST_ROOT 为唯一真源）。
#   网络条件允许后，可改回 uv sync 版本以获得自包含镜像。
# ==================================================================

ARG CUDA_TAG=12.8.1-base-ubuntu24.04
FROM nvidia/cuda:${CUDA_TAG}

ARG DEBIAN_FRONTEND=noninteractive
# 宿主仓库根。用于把 venv 的 bin 目录挂进 PATH；compose 会用同一个变量做挂载。
ARG HOST_ROOT=/home/hip/桌面/work/general_server

ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHONUTF8=1 \
    # 依赖以只读方式挂载，避免 Python 往宿主 venv 里写 __pycache__
    PYTHONDONTWRITEBYTECODE=1 \
    TOKENIZERS_PARALLELISM=false \
    # 与宿主 worker 保持一致：引擎需要它才能解析模型名（宿主 IndexttsWorker 也这样注入）
    HF_ENDPOINT=https://hf-mirror.com \
    # 减少显存碎片（与 duix 容器共用一张 20GB 卡）
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    # 桥接层；engine 目录由 compose 挂载，其路径在运行时再补进 PYTHONPATH
    PYTHONPATH=/opt/indextts/bridge \
    INDEXTTS_STATE_DIR=/var/lib/indextts \
    INDEXTTS_SERVICE_PORT=8000

# venv 的 bin 进 PATH，docker CMD 才能直接调用 uvicorn，健康检查也才有 python
ENV PATH=${HOST_ROOT}/services/indextts/engine/.venv/bin:$PATH

# ---- 系统依赖 ----
# libsndfile1: librosa/soundfile 读 wav
# ffmpeg:      descript-audiotools 等对非 wav 输入的兜底解码
# libgomp1:    torch 的 OpenMP 运行时
# tzdata:      让 TZ=Asia/Shanghai 真正生效（日志时间戳与 Node 侧对齐）
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg libsndfile1 libgomp1 tzdata \
 && rm -rf /var/lib/apt/lists/*

# ---- 桥接层 + HTTP 适配层（仅数百 KB，构建秒级完成）----
COPY services/indextts/indextts_engine.py \
     services/indextts/indextts_worker.py \
     services/indextts/run_indextts.py \
     services/indextts/progress.py \
     services/indextts/job_runner.py \
     /opt/indextts/bridge/
COPY services/indextts/http/ /opt/indextts/bridge/http/

# uid 1000 与宿主 hip 对齐：state 卷与日志目录里的文件不会变成 root 所有
RUN mkdir -p /var/lib/indextts /var/log/indextts \
 && chown -R 1000:1000 /var/lib/indextts /var/log/indextts
USER 1000:1000

# 工作目录必须是引擎目录，不能是别处。
#
# 原因很隐蔽：engine/indextts/infer_v2.py 第 4 行是
#     os.environ['HF_HUB_CACHE'] = './checkpoints/hf_cache'
# —— **相对路径**，按进程 cwd 解析。宿主侧 IndexttsWorker 用 cwd=installDir 拉起子进程，
# 于是指向 <engine>/checkpoints/hf_cache（真正的模型缓存所在）。若容器 cwd 不是引擎目录，
# 该变量会指向一个不存在的目录 → 缓存落空 → transformers 转去访问 huggingface.co → 失败。
# 目录在运行时由 compose 挂载提供；此处声明它只是为了让镜像本身也能独立运行。
WORKDIR ${HOST_ROOT}/services/indextts/engine

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=600s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=5).status == 200 else 1)"

# --workers 1 是硬约束：进程内队列 + 单份热模型。多 worker 会各加载一份 7.8GB 模型。
#
# 用 `python -m uvicorn` 而不是直接调 venv 里的 `uvicorn` 脚本：该脚本的 shebang 指向
# 仓库外的 /home/hip/桌面/work/JY_IPAgent/tools/IndexTTS/.venv/bin/python（本机 venv 是从
# 那个检出安装的），该路径在容器内不存在，直接 exec 会报 "no such file or directory"。
# 走 `python -m` 只用 venv 自身的解释器（其符号链接链随挂载完整可用）。
CMD ["python", "-m", "uvicorn", "server:app", \
     "--app-dir", "/opt/indextts/bridge/http", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--timeout-keep-alive", "75"]
