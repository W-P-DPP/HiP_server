# syntax=docker/dockerfile:1.7
#
# 图片理解（Qwen3-VL）推理服务镜像。
#
# 与 services/whisper/Dockerfile 同款的「依赖策略」：**不在镜像内装 Python 依赖**，
# 而是复用宿主侧已经装好的 venv（compose 只读挂载 + PATH 前置）。理由：到 pypi / CUDA
# 源的国际带宽不稳定，复用现成 venv 可零下载、无版本漂移；代价是容器不自包含，
# 宿主路径必须逐字一致（HOST_ROOT）。
ARG CUDA_TAG=12.8.1-base-ubuntu24.04
FROM nvidia/cuda:${CUDA_TAG}

ARG DEBIAN_FRONTEND=noninteractive
ARG HOST_ROOT=/home/hip/桌面/work/general_server

# HF_HOME 必须指进命名卷。不设的话 huggingface_hub 与 hf_xet 会把下载缓存放在
# `~/.cache/huggingface`，那是**容器可写层**：① 容器一重建（compose 改一行就会重建）就要重下
# 约 9GB；② 缓存与权重在卷上各存一份，白占一倍空间。
#
# 另注：HF_HUB_DISABLE_XET=1 在 huggingface_hub 1.x 上已**不生效**（该版改用独立的 hf_xet 包），
# 实测走 Xet 也能正常下载（hf-mirror 现已代理 cas-bridge.xethub.hf.co）。保留它只为兼容旧版 hub。
#
# TORCH_DISABLE_NATIVE_JIT=1：torch 2.14 引入的 `torch/_native` 注册表会把**小算子**派发给
# triton 编译的原生内核，而 triton 是**运行时 JIT**，需要容器里有 C 编译器 —— 否则 Qwen3-VL
# 的 RoPE 里那句 `inv_freq @ position_ids` 会直接报
#   Failed to find C compiler. Please specify via CC environment variable or set triton.knobs.build.impl
# （实测正是卡在这里）。关掉之后这类算子走普通 eager 实现：它们本来就极小（一个 2D matmul），
# triton 版没有可感知的收益，却要额外背上 gcc 和首次 JIT 的编译等待。
# 若将来确实需要那条加速路径：装上 gcc（`apt-get install -y build-essential`）并把本变量去掉，
# 同时建议把 TRITON_CACHE_DIR 也指到卷上，免得每次重建都重编。
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHONUTF8=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_ENDPOINT=https://hf-mirror.com \
    HUGGINGFACE_HUB_ENDPOINT=https://hf-mirror.com \
    HF_HUB_DISABLE_XET=1 \
    HF_HOME=/var/lib/vlm \
    TORCH_DISABLE_NATIVE_JIT=1 \
    PYTHONPATH=/opt/vlm/bridge \
    VLM_STATE_DIR=/var/lib/vlm \
    VLM_SERVICE_PORT=8000

# venv 的 bin 前置：CMD 用 `python -m uvicorn`（不是 venv 里的 uvicorn 脚本 —— 那个脚本的
# shebang 带宿主绝对路径）
ENV PATH=${HOST_ROOT}/services/vlm/engine/.venv/bin:$PATH

# libgomp1 是 torch 的 OpenMP 运行时，缺了会在 import torch 时直接失败。
# 刻意不装 ffmpeg：本服务只吃图片（jpg/png/webp/bmp），不解码任何音视频 ——
# 这是与 services/whisper 的一处实质差异。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl libgomp1 tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY services/vlm/vlm_engine.py services/vlm/run_vlm.py /opt/vlm/bridge/
COPY services/vlm/http/ /opt/vlm/bridge/http/

RUN mkdir -p /var/lib/vlm \
 && chown -R 1000:1000 /var/lib/vlm
USER 1000:1000

WORKDIR /opt/vlm/bridge

EXPOSE 8000

# 探 /healthz 而不是 /readyz。
#
# 本服务默认「懒加载 + 空闲卸载」，未加载模型时 /readyz 合法地返回 503；拿它当健康检查，
# 会让一个完全正常的容器在被空闲卸载后立刻被判 unhealthy。健康检查回答的是「进程还活着吗」，
# 那正是 /healthz 的语义；「模型在不在位」由调用方按 /readyz 或 /api/v1/status 自行判断。
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).status == 200 else 1)"

# --workers 1 是硬约束：多进程会各加载一份模型（显存翻倍）并各自维护队列。
#
# 启 uvicorn 之前先自检解释器能不能执行。
#
# 为什么需要这个自检：本镜像**不装 Python**，直接复用宿主的 venv（PATH 前置）。如果那个 venv
# 是用 `python3 -m venv` 建的，它的 bin/python 是指向**宿主系统解释器**的软链，容器里没有这个
# 路径 —— 默认报错只有一句 `exec: "python": executable file not found in $PATH`，
# 完全看不出与 venv 的建法有关（实测为此困惑过一轮）。这里换成一条能直接照做的提示。
# 必须真正执行一次（`python -c pass`）而不是 `command -v python`：后者对断链的软链不可靠。
CMD ["sh", "-c", "if ! python -c 'pass' >/dev/null 2>&1; then echo 'FATAL: 容器内无法执行 python。宿主 venv 必须用 uv venv --python-preference only-managed 创建（解释器要落在 ~/.local/share/uv/python/ 下，compose 会按原路径挂进容器）；用 python3 -m venv 建的 venv 指向宿主系统解释器，容器里没有。详见 services/vlm/README.md 的「安装」。' >&2; exit 127; fi; exec python -m uvicorn server:app --app-dir /opt/vlm/bridge/http --host 0.0.0.0 --port 8000 --workers 1 --timeout-keep-alive 75"]
