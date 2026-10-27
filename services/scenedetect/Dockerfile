# =============================================================
# scenedetect —— PySceneDetect 场景切分（CPU-only，独立 HTTP 容器）
# =============================================================
# 与 services/vlm、services/whisper 同为「独立 Python 服务容器」，但不需要 GPU，
# 因此基镜像用 python:3.12-slim，并把依赖**直接装进镜像**（不再复用宿主 venv）：
#   - 本服务纯 CPU，镜像体积可控；
#   - 绕开「宿主 venv 用 python3 -m venv 建、bin/python 指向宿主解释器，容器里装不出来」这一坑
#     （见 services/vlm/README.md「为什么不能用 python3 -m venv」）；
#   - 生产部署不再依赖运维先装好 engine/.venv。
#
# 构建上下文是仓库根（见 docker-compose.yml 的 context: ../..），
# 裁剪规则在 Dockerfile.dockerignore。
# =============================================================

FROM python:3.12-slim

ARG DEBIAN_FRONTEND=noninteractive

ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHONUTF8=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/opt/scenedetect \
    SCENEDETECT_SERVICE_PORT=8000

# libglib2.0-0 / libgomp1：opencv-python-headless 运行期依赖（headless 不含 GUI，无需 libGL）
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates tzdata libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /opt/scenedetect

# 先装依赖再拷代码，充分利用层缓存
COPY services/scenedetect/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 检测核心（bridge）+ HTTP 服务
COPY services/scenedetect/detect_scenes.py ./detect_scenes.py
COPY services/scenedetect/http/ ./http/

RUN useradd -u 1000 -m scenedetect && chown -R 1000:1000 /opt/scenedetect
USER 1000:1000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).status == 200 else 1)"

CMD ["python", "-m", "uvicorn", "server:app", \
     "--app-dir", "/opt/scenedetect/http", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--timeout-keep-alive", "75"]
