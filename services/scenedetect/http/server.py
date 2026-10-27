"""PySceneDetect 场景切分 HTTP 服务（services/scenedetect）。

Node 侧 `utils/scenedetect/ScenedetectHttpClient.ts` 调用本服务，契约见 ../README.md：
    GET  /healthz          无鉴权，恒 200（存活）
    GET  /readyz           无鉴权，恒 200（无模型加载，就绪即存活）
    POST /api/v1/detect    Bearer；JSON 入参 → 与检测脚本 stdout 同构的 JSON 出参

检测是纯 CPU、可长达数分钟的操作，故在 `asyncio.to_thread` 里跑，用信号量限并发（默认 1）。
失败语义刻意与脚本对齐：检测本身失败返回 200 + `{ok:false,error}`，只有「请求/入参/鉴权」才用 4xx。
"""

from __future__ import annotations

import asyncio
import logging
import sys
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

# uvicorn --app-dir 会把 http/ 放进 sys.path，但检测脚本在上一级（bridge），需要显式补上。
BRIDGE_DIR = Path(__file__).resolve().parent.parent
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from fastapi import Depends, FastAPI, Header, HTTPException, Request  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from detect_scenes import DETECTORS, detect_video  # noqa: E402
from settings import Settings  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("scenedetect")


class DetectRequest(BaseModel):
    """场景检测入参（未给的字段交回检测脚本的缺省值）。字段名用 snake_case（Python 侧惯例）。"""

    input: str = Field(..., description="输入视频绝对路径（须在 scenedetect 容器内可达）")
    detector: str = Field(default="content", description="content / adaptive / threshold")
    threshold: float | None = Field(default=None, description="检测阈值，缺省用算法的推荐值")
    min_scene_len: float | None = Field(default=None, description="最短场景时长（秒），缺省 0.6")
    downscale: int | None = Field(default=None, description="检测前降采样倍数，缺省自适应")
    frame_skip: int | None = Field(default=None, description="隔帧采样数，缺省 0")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.from_env()
    app.state.settings = settings
    app.state.semaphore = asyncio.Semaphore(settings.max_concurrency)

    if not settings.api_token:
        log.warning("SCENEDETECT_API_TOKEN 为空 —— 接口无鉴权，请只绑回环/内网")
    log.info(
        "scenedetect 服务就绪：port=%s concurrency=%s allowed_root=%s",
        settings.port,
        settings.max_concurrency,
        settings.allowed_root or "(不限)",
    )
    yield


app = FastAPI(title="PySceneDetect Scene Detection Service", version="1.0.0", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def _on_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """把 FastAPI 默认的 422 改成 400 + 可读文案（Node 侧只按 <500 判 clientFault）。"""
    fields = "、".join(str(err.get("loc", ["?"])[-1]) for err in exc.errors())
    return JSONResponse(
        status_code=400,
        content={"detail": f"请求体不合法：字段 {fields} 缺失或类型错误"},
    )


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def require_token(request: Request, authorization: str | None = Header(default=None)) -> None:
    """共享 Bearer 校验；token 为空则跳过（仅限内网部署）。"""
    token = _settings(request).api_token
    if not token:
        return
    if authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


Auth = Depends(require_token)


@app.get("/healthz")
async def healthz() -> dict:
    """存活探针：恒 200，供 compose healthcheck 与 deploy.sh verify 使用。"""
    return {"status": "ok"}


@app.get("/readyz")
async def readyz() -> dict:
    """就绪探针：本服务无模型加载，就绪即存活，恒 200。"""
    return {"status": "ready"}


@app.post("/api/v1/detect", dependencies=[Auth])
async def detect(payload: DetectRequest, request: Request) -> JSONResponse:
    """执行场景切分，返回与检测脚本 stdout 同构的 JSON（ok / version / scenes / durationMs ...）。"""
    settings = _settings(request)

    input_path = Path(payload.input).expanduser()
    if not input_path.is_absolute():
        return JSONResponse(status_code=400, content={"detail": f"input 必须是绝对路径：{payload.input}"})
    if settings.allowed_root is not None and not input_path.is_relative_to(settings.allowed_root):
        return JSONResponse(
            status_code=400,
            content={"detail": f"input 不在允许的目录内：{settings.allowed_root}"},
        )
    if not input_path.is_file():
        return JSONResponse(status_code=400, content={"detail": f"输入视频不存在：{input_path}"})
    if payload.detector not in DETECTORS:
        return JSONResponse(status_code=400, content={"detail": f"未知检测算法：{payload.detector}"})

    try:
        async with request.app.state.semaphore:
            result = await asyncio.to_thread(
                detect_video,
                str(input_path),
                detector=payload.detector,
                threshold=payload.threshold,
                min_scene_len_sec=payload.min_scene_len,
                downscale=payload.downscale,
                frame_skip=payload.frame_skip,
            )
    except (FileNotFoundError, ModuleNotFoundError, ValueError) as err:
        # 类「输入不可读 / 缺依赖」：属调用方可处理的问题，用 400，不计服务故障
        return JSONResponse(status_code=400, content={"detail": f"场景检测失败：{err}"})
    except Exception as err:  # noqa: BLE001 - 与脚本一致：检测本身失败也回 ok=false 的 JSON
        log.error("场景检测异常：%s\n%s", err, traceback.format_exc())
        return JSONResponse(status_code=200, content={"ok": False, "error": f"场景检测失败：{err}"})

    return JSONResponse(status_code=200, content=result)
