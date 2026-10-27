"""独立 Whisper ASR 服务的配置。

与 `services/indextts/http/settings.py` 同构：全部来自环境变量、无配置文件、`frozen`
dataclass，另提供派生路径与喂给引擎的配置结构。

命名沿用 Node 侧的 `WHISPER_*` 前缀（`utils/whisper/whisper.config.ts`），重叠项语义保持一致：
`WHISPER_API_TOKEN` / `WHISPER_LANGUAGE` 两侧含义相同。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_bool(name: str, fallback: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return fallback
    return raw.strip().lower() in ("true", "1", "yes", "on")


def _env_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return fallback
    try:
        return int(raw.strip())
    except ValueError:
        return fallback


def _env_float(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return fallback
    try:
        return float(raw.strip())
    except ValueError:
        return fallback


def normalize_language(raw: str | None, default: str) -> str | None:
    """请求语种 → faster-whisper 的 `language`。

    `auto` / `autodialect` / 空 一律映射为 `None`（让引擎自动检测）—— Node 侧的
    `ASR_LANGUAGE` 默认值就是讯飞口径的 `autodialect`，直接透传会被引擎当成语种名而报错。
    """
    value = (raw or "").strip() or (default or "").strip()
    if not value or value.lower() in ("auto", "autodialect"):
        return None
    return value


@dataclass(frozen=True)
class Settings:
    """服务配置。全部来自环境变量。"""

    # ---- 服务自身 ----
    api_token: str = ""
    state_dir: Path = field(default_factory=lambda: Path("/var/lib/whisper"))
    port: int = 8000
    eager_load: bool = True
    max_queue: int = 64
    max_upload_mb: int = 100
    result_ttl_ms: int = 1_800_000
    expose_trace: bool = False
    # 注意：服务端**不**强制 job 超时 —— 硬超时只会制造「还在跑却已标记失败」的假象，
    # 超时判定交给 Node 侧的 WHISPER_JOB_TIMEOUT_MS。
    job_timeout_ms: int = 600_000

    # ---- 引擎 ----
    model: str = "large-v3"
    device: str = "cuda"
    compute_type: str = "float16"
    language: str = "zh"
    beam_size: int = 5
    vad_filter: bool = True
    allow_download: bool = True
    #: 兜底硬切阈值：标点处必断（产物不带标点），只有整段无标点超过它才硬切。见 whisper_engine.split_long_text
    max_chars: int = 20

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            api_token=os.environ.get("WHISPER_API_TOKEN", "").strip(),
            state_dir=Path(os.environ.get("WHISPER_STATE_DIR", "/var/lib/whisper")).expanduser(),
            port=_env_int("WHISPER_SERVICE_PORT", 8000),
            eager_load=_env_bool("WHISPER_EAGER_LOAD", True),
            max_queue=_env_int("WHISPER_MAX_QUEUE", 64),
            max_upload_mb=_env_int("WHISPER_MAX_UPLOAD_MB", 100),
            result_ttl_ms=_env_int("WHISPER_RESULT_TTL_MS", 1_800_000),
            expose_trace=_env_bool("WHISPER_EXPOSE_TRACE", False),
            job_timeout_ms=_env_int("WHISPER_JOB_TIMEOUT_MS", 600_000),
            model=os.environ.get("WHISPER_MODEL", "large-v3").strip() or "large-v3",
            device=os.environ.get("WHISPER_DEVICE", "cuda").strip() or "cuda",
            compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "float16").strip() or "float16",
            language=os.environ.get("WHISPER_LANGUAGE", "zh").strip(),
            beam_size=_env_int("WHISPER_BEAM_SIZE", 5),
            vad_filter=_env_bool("WHISPER_VAD_FILTER", True),
            allow_download=_env_bool("WHISPER_ALLOW_DOWNLOAD", True),
            max_chars=_env_int("WHISPER_MAX_CHARS_PER_CUE", 20),
        )

    # ---- 派生路径 ----

    @property
    def refs_dir(self) -> Path:
        """上传音频的落点（job 结束即随 TTL 清理）。"""
        return self.state_dir / "refs"

    @property
    def out_dir(self) -> Path:
        """SRT 产物落点。"""
        return self.state_dir / "out"

    @property
    def models_dir(self) -> Path:
        """faster-whisper 的 download_root（权重缓存，命名卷持久化）。"""
        return self.state_dir / "models"

    @property
    def registry_file(self) -> Path:
        return self.state_dir / "jobs.jsonl"

    def ensure_dirs(self) -> None:
        for path in (self.state_dir, self.refs_dir, self.out_dir, self.models_dir):
            path.mkdir(parents=True, exist_ok=True)

    # ---- 引擎配置 ----

    def engine_config(self) -> dict:
        """喂给 `whisper_engine` 的配置结构（避免引擎反向依赖本模块）。"""
        return {
            "model": self.model,
            "device": self.device,
            "compute_type": self.compute_type,
            "download_root": self.models_dir,
            "allow_download": self.allow_download,
            "beam_size": self.beam_size,
            "vad_filter": self.vad_filter,
            "max_chars": self.max_chars,
        }

    def resolve_language(self, requested: str | None) -> str | None:
        """把请求里的语种归一成 faster-whisper 可接受的值（见 `normalize_language`）。"""
        return normalize_language(requested, self.language)

    def fingerprint(self) -> str:
        """配置指纹，便于日志里分辨「跑的是哪套参数」。"""
        return "|".join(
            [
                f"model={self.model}",
                f"device={self.device}",
                f"compute={self.compute_type}",
                f"lang={self.language}",
                f"beam={self.beam_size}",
                f"vad={self.vad_filter}",
            ]
        )
