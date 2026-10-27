"""scenedetect HTTP 服务配置（全部来自环境变量）。

与 services/vlm / services/whisper 的 settings 同构：冻结 dataclass + from_env()。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


def _env_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return fallback
    try:
        return int(raw.strip())
    except ValueError:
        return fallback


@dataclass(frozen=True)
class Settings:
    """运行期配置（env → 冻结实例，构造后不再变）。"""

    # 空 = 不鉴权（仅限回环/内网；启动时会给 warning）
    api_token: str = ""
    # 监听端口（compose 里固定 8000，容器内）
    port: int = 8000
    # 同时进行的检测数上限。检测是纯 CPU 逐帧分析，默认 1：并发只会互相拖慢。
    max_concurrency: int = 1
    # 只允许检测该目录下的视频（None = 不限制）。本服务会把宿主 uploads 挂进来，故一般配它更安全。
    allowed_root: Optional[Path] = None

    @classmethod
    def from_env(cls) -> "Settings":
        allowed = os.environ.get("SCENEDETECT_ALLOWED_ROOT", "").strip()
        return cls(
            api_token=os.environ.get("SCENEDETECT_API_TOKEN", "").strip(),
            port=_env_int("SCENEDETECT_SERVICE_PORT", 8000),
            max_concurrency=max(1, _env_int("SCENEDETECT_MAX_CONCURRENCY", 1)),
            allowed_root=Path(allowed).expanduser() if allowed else None,
        )
