"""独立 IndexTTS GPU 服务的配置。

与 Node 侧 `utils/indextts/indextts.config.ts` 的关系：那边负责**生成** JSON 配置喂给
stdio worker；容器化后配置改由本服务自己从环境变量解析，不再依赖 Node 写盘。命名沿用
同一个前缀（`INDEXTTS_*`）以降低心智负担，重叠项语义保持一致。
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
        value = int(raw.strip())
    except ValueError:
        return fallback
    return value


def _env_float(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return fallback
    try:
        return float(raw.strip())
    except ValueError:
        return fallback


@dataclass(frozen=True)
class Settings:
    """服务配置。全部来自环境变量，无配置文件。"""

    # ---- 服务自身 ----
    api_token: str = ""
    state_dir: Path = field(default_factory=lambda: Path("/var/lib/indextts"))
    port: int = 8000
    eager_load: bool = True
    max_queue: int = 64
    max_upload_mb: int = 20
    max_text_chars: int = 1000
    result_ttl_ms: int = 1_800_000
    expose_trace: bool = False
    # 注意：服务端**不**强制 job 超时。CUDA 推理无法安全打断，硬超时只会制造
    # 「任务还在跑但已被标记失败」的假象。超时判定由 Node 侧的 jobTimeoutMs 负责。
    job_timeout_ms: int = 600_000

    # ---- 引擎 ----
    install_dir: Path = field(default_factory=lambda: Path("/opt/indextts/engine"))
    model_dir: str = "checkpoints"
    use_fp16: bool = True
    allow_download: bool = False
    temperature: float = 0.8
    top_p: float = 0.8
    top_k: int = 30
    interval_silence: int = 200
    max_text_tokens_per_segment: int = 120
    clone_temperature: float = 0.75

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            api_token=os.environ.get("INDEXTTS_API_TOKEN", "").strip(),
            state_dir=Path(os.environ.get("INDEXTTS_STATE_DIR", "/var/lib/indextts")).expanduser(),
            port=_env_int("INDEXTTS_SERVICE_PORT", 8000),
            eager_load=_env_bool("INDEXTTS_EAGER_LOAD", True),
            max_queue=_env_int("INDEXTTS_MAX_QUEUE", 64),
            max_upload_mb=_env_int("INDEXTTS_MAX_UPLOAD_MB", 20),
            max_text_chars=_env_int("INDEXTTS_MAX_TEXT_CHARS", 1000),
            result_ttl_ms=_env_int("INDEXTTS_RESULT_TTL_MS", 1_800_000),
            expose_trace=_env_bool("INDEXTTS_EXPOSE_TRACE", False),
            job_timeout_ms=_env_int("INDEXTTS_JOB_TIMEOUT_MS", 600_000),
            install_dir=Path(os.environ.get("INDEXTTS_INSTALL_DIR", "/opt/indextts/engine")).expanduser(),
            model_dir=os.environ.get("INDEXTTS_MODEL_DIR", "checkpoints"),
            use_fp16=_env_bool("INDEXTTS_USE_FP16", True),
            allow_download=_env_bool("INDEXTTS_ALLOW_DOWNLOAD", False),
            temperature=_env_float("INDEXTTS_TEMPERATURE", 0.8),
            top_p=_env_float("INDEXTTS_TOP_P", 0.8),
            top_k=_env_int("INDEXTTS_TOP_K", 30),
            interval_silence=_env_int("INDEXTTS_INTERVAL_SILENCE", 200),
            max_text_tokens_per_segment=_env_int("INDEXTTS_MAX_TEXT_TOKENS_PER_SEGMENT", 120),
            clone_temperature=_env_float("INDEXTTS_CLONE_TEMPERATURE", 0.75),
        )

    # ---- 派生路径 ----
    @property
    def refs_dir(self) -> Path:
        """上传的参考音落点。"""
        return self.state_dir / "refs"

    @property
    def gen_dir(self) -> Path:
        """运行期生成物（config.agent.yaml 等）。权重只读挂载时，这里必须可写。"""
        return self.state_dir / "gen"

    @property
    def out_dir(self) -> Path:
        """合成产物 wav 落点。"""
        return self.state_dir / "out"

    @property
    def registry_file(self) -> Path:
        return self.state_dir / "jobs.jsonl"

    def ensure_dirs(self) -> None:
        for path in (self.state_dir, self.refs_dir, self.gen_dir, self.out_dir):
            path.mkdir(parents=True, exist_ok=True)

    def engine_config(self) -> dict:
        """构造 indextts_engine 期望的配置结构（原来由 Node 写 JSON 提供）。"""
        return {
            "paths": {"indextts_dir": str(self.install_dir)},
            "indextts": {
                "model_dir": self.model_dir,
                "use_fp16": self.use_fp16,
                "allow_download": self.allow_download,
                "temperature": self.temperature,
                "top_p": self.top_p,
                "top_k": self.top_k,
                "interval_silence": self.interval_silence,
                "max_text_tokens_per_segment": self.max_text_tokens_per_segment,
                "clone_temperature": self.clone_temperature,
            },
        }

    def fingerprint(self) -> str:
        """配置指纹，便于日志里分辨「跑的是哪套参数」。"""
        return "|".join(
            [
                f"fp16={self.use_fp16}",
                f"model={self.model_dir}",
                f"maxtext={self.max_text_chars}",
                f"temp={self.temperature}",
                f"top_p={self.top_p}",
                f"top_k={self.top_k}",
            ]
        )
