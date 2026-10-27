# syntax=docker/dockerfile:1.7
#
# 独立 Whisper ASR 服务。
#
# 构建上下文是**仓库根**（见 docker-compose.yml 的 context: ../..），配套的
# Dockerfile.dockerignore 会剔除 engine/（venv + 权重，数 GB），实测上下文仅数十 KB。
#
# ============================ 依赖策略 ============================
# 与 services/indextts 同款：**复用宿主已有的 services/whisper/engine/.venv**，不在镜像内
# 安装 Python 依赖。
#
# 为什么不在镜像内 `pip install`：构建机到 pypi / 各 CUDA 源的国际带宽不稳定，而宿主 venv
# 已是一份**可用、且与本地验证环境完全一致**的依赖集。直接复用既零下载，又消除版本漂移。
#
# 代价：镜像不自包含，运行时必须挂载宿主目录，且**容器内路径须与宿主完全一致** ——
# venv 里的 python 是指向 uv Python 的符号链接、bin/* 的 shebang 也是绝对路径，换路径即断链。
# 挂载由 docker-compose.yml 负责（HOST_ROOT 为唯一真源）。
# ==================================================================
#
# ============================ CUDA 运行库 ============================
# CTranslate2 **不自带** cuBLAS/cuDNN（这点与 IndexTTS 的 torch 轮子不同，torch 是会自带的），
# 它通过 dlopen 在系统默认路径里找 libcublas.so.12 / libcudnn.so.9。
#
# 做法：由 requirements.txt 装 pip 的 nvidia-cublas-cu12 / nvidia-cudnn-cu12（它们落在**宿主
# venv**里，随后被只读挂载进容器），再由 whisper_engine.preload_cuda_libraries() 以
# RTLD_GLOBAL 显式预加载 —— 因为 LD_LIBRARY_PATH 只在进程启动时由动态链接器读取，Python 里改
# os.environ 对已运行的进程无效，而 site-packages/nvidia/*/lib 又不在默认搜索路径上。
#
# 因此基础镜像用与 indextts 相同的 `-base-`（只含驱动接口，不含 cuDNN）即可，无需 cudnn-runtime。
# ====================================================================

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
    # 优先国内镜像下载权重（宿主直接跑 CLI 时由 whisper_engine.configure_hf_mirror 兜底）
    HF_ENDPOINT=https://hf-mirror.com \
    HUGGINGFACE_HUB_ENDPOINT=https://hf-mirror.com \
    # 镜像没有代理 Xet 的 CAS 存储，开着会 401 导致权重下载整体失败
    HF_HUB_DISABLE_XET=1 \
    # 桥接层（引擎 + HTTP 适配层）
    PYTHONPATH=/opt/whisper/bridge \
    WHISPER_STATE_DIR=/var/lib/whisper \
    WHISPER_SERVICE_PORT=8000

# venv 的 bin 进 PATH，docker CMD 才能直接调用 uvicorn，健康检查也才有 python
ENV PATH=${HOST_ROOT}/services/whisper/engine/.venv/bin:$PATH

# ---- 系统依赖 ----
# ffmpeg:  faster-whisper 经 PyAV 解码非 wav 输入（mp3/m4a/…）时的兜底
# libgomp1: CTranslate2/OpenMP 运行时
# tzdata:  让 TZ=Asia/Shanghai 真正生效（日志时间戳与 Node 侧对齐）
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg libgomp1 tzdata \
 && rm -rf /var/lib/apt/lists/*

# ---- 桥接层 + HTTP 适配层（仅数十 KB，构建秒级完成）----
COPY services/whisper/whisper_engine.py services/whisper/run_whisper.py /opt/whisper/bridge/
COPY services/whisper/http/ /opt/whisper/bridge/http/

# uid 1000 与宿主 hip 对齐：state 卷里的文件不会变成 root 所有
RUN mkdir -p /var/lib/whisper \
 && chown -R 1000:1000 /var/lib/whisper
USER 1000:1000

WORKDIR /opt/whisper/bridge

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=900s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=5).status == 200 else 1)"

# --workers 1 是硬约束：进程内队列 + 单份热模型。多 worker 会各加载一份模型、各自排队。
#
# 用 `python -m uvicorn` 而不是直接调 venv 里的 `uvicorn` 脚本：该脚本的 shebang 是创建 venv
# 时的绝对路径，走 `python -m` 只用 venv 自身的解释器，不受 shebang 影响。
CMD ["python", "-m", "uvicorn", "server:app", \
     "--app-dir", "/opt/whisper/bridge/http", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--timeout-keep-alive", "75"]
