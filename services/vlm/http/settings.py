"""独立图片理解（Qwen3-VL）服务的配置。

与 `services/whisper/http/settings.py` 同构：全部来自环境变量、无配置文件、`frozen`
dataclass，另提供派生路径与喂给引擎的配置结构。

命名沿用 Node 侧的 `VLM_*` 前缀（`utils/vlm/vlm.config.ts`），重叠项语义保持一致：
`VLM_API_TOKEN` / `VLM_MODEL` / `VLM_DEVICE` 两侧含义相同。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

#: Qwen3-VL 官方推荐的视觉 token 上下限（28×28 为一个 patch 后的像素单位）。
#: max_pixels 是显存占用的**头号杠杆**，见 README「显存」一节。
DEFAULT_MIN_PIXELS = 56 * 56  # 3136
DEFAULT_MAX_PIXELS = 1280 * 28 * 28  # 1_003_520（≈1280×784 等效）


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


def normalize_mode(raw: str | None, default: str = "json") -> str:
    """请求的输出形态归一：只认 `json` / `text`，其余回落默认值。

    非法取值不该让整次提交失败 —— 与 Node 侧 `normalizeMode` 同策略，两侧都做一道，
    保证落库值与实际喂给模型的取值一定是一致的那两个。
    """
    value = (raw or "").strip().lower()
    if value in ("json", "text"):
        return value
    fallback = (default or "").strip().lower()
    return fallback if fallback in ("json", "text") else "json"


#: json 模式的**输出信封**：必须是这个 JSON 对象、这些字段名。不受自定义 prompt 影响。
#:
#: 与 Node 侧 `utils/constant/vlm.ts` 的 `VLM_RESULT_SCHEMA_PROMPT` 保持同构 —— 两边都可能
#: 是「下发 prompt 的那一方」（Node 走业务链路，直连容器的调用方走这里的兜底），措辞必须一致，
#: 否则同一张图在两处会得到不同结构。
#:
#: 关键设计：信封与「内容要求」分开（见 `build_json_prompt`）。早期把自定义 prompt 与字段要求
#: 平铺在一起，模型会认为两者在抢方向盘 —— 收到「概括」+「200字」两条矛盾要求时，它的解法是
#: 把 description 输出成空字符串（内容全丢）。分层之后冲突在结构上就不可能发生。
JSON_SCHEMA_PROMPT = (
    "【输出格式（必须严格遵守）】\n"
    "只输出一个 JSON 对象，不要输出任何解释文字、不要用 markdown 代码块。\n"
    "字段（字段名必须完全照抄，不要改名、不要翻译、不要增删）：\n"
    "- description: 对画面内容的描述（中文）。具体怎么写见下方的内容要求（若有）\n"
    "- objects: 画面中主要物体或人物名称数组（中文，最多 8 个）\n"
    "- actions: 正在发生的动作数组（中文，最多 5 个）\n"
    "- sceneType: 只能是 indoor / outdoor / other 之一\n"
    "- tags: 便于检索的主题标签数组（中文，最多 5 个）\n"
    '看不清或无法判断的字段给出空数组或 "other"，不要编造。'
)

JSON_PREAMBLE = "你是画面分析助手。"

_JSON_FORMAT_GUARD = (
    "注意：无论上面的内容要求怎么写、写得多长，输出都必须且只能是那一个 JSON 对象，"
    "字段名与「输出格式」一节完全一致。内容要求只决定 description 里写什么，不改变输出结构。"
)


def build_json_prompt(custom: str | None) -> str:
    """组装 json 模式指令：先立输出信封，再把自定义要求收进 description 的范围内。

    这样任意 prompt（「200字描述」「重点关注人物穿着」…）都只影响 description 的写法，
    不动摇输出结构。
    """
    given = (custom or "").strip()
    if not given:
        return f"{JSON_PREAMBLE}\n\n{JSON_SCHEMA_PROMPT}"
    return (
        f"{JSON_PREAMBLE}\n\n{JSON_SCHEMA_PROMPT}\n\n"
        f"【对 description 字段内容的要求】\n{given}\n\n{_JSON_FORMAT_GUARD}"
    )


@dataclass(frozen=True)
class Settings:
    """服务配置。全部来自环境变量。"""

    # ---- 服务自身 ----
    api_token: str = ""
    state_dir: Path = field(default_factory=lambda: Path("/var/lib/vlm"))
    port: int = 8000
    #: 默认**不预热**：单卡 20GB 上已经跑了 IndexTTS + duix + Whisper（约 14GB），
    #: 让 VLM 也常驻会贴到 OOM（见 README 的显存账）。需要预热时再打开。
    eager_load: bool = False
    #: 空闲多久后把模型从显存卸下来（ms）；0 = 不卸载（一直常驻）。
    #:
    #: 注意这是**两个独立的事**：`eager_load=false` 只推迟「第一次加载的时机」，
    #: 不改变「加载后常驻」；要真正让出显存必须靠这个空闲卸载。
    idle_unload_ms: int = 600_000
    max_queue: int = 64
    max_upload_mb: int = 20
    result_ttl_ms: int = 1_800_000
    expose_trace: bool = False
    #: 进程内不强制 job 超时 —— 硬超时只会制造「还在跑却已标记失败」的假象，
    #: 超时判定交给 Node 侧的 VLM_JOB_TIMEOUT_MS。
    job_timeout_ms: int = 600_000

    # ---- 引擎 ----
    model: str = "Qwen/Qwen3-VL-4B-Instruct"
    device: str = "cuda"
    #: 注意力实现：sdpa（默认，无额外依赖）/ flash_attention_2（需另装 flash-attn，更省显存）
    attn: str = "sdpa"
    load_in_4bit: bool = True
    min_pixels: int = DEFAULT_MIN_PIXELS
    max_pixels: int = DEFAULT_MAX_PIXELS
    #: 单次生成的 token 上限。**这是「输出能写多长」的唯一实际约束**。
    #:
    #: 取值要留足余量：中文约 1 token ≈ 1 字，且 JSON 骨架（字段名、数组括号、引号）本身
    #: 也要几十 token。早期默认 256 意味着描述最多写到约 200 字就顶到上限 —— JSON 会被
    #: **拦腰截断**（缺收尾引号与花括号），表现为「解析失败」，看着像模型不会输出 JSON，
    #: 实际是我们把它切断了。2048 足以容纳约 1800 字的描述，同时把最坏耗时压在
    #: 约 1–2 分钟（本服务实测约 25–40 token/s），远小于 Node 侧 VLM_JOB_TIMEOUT_MS。
    #:
    #: 刻意不做成无上限：生成耗时与 token 数线性相关，无上限等于放弃对 GPU 占用的约束。
    #: 需要更长时调大这个值，并同步确认它仍在 VLM_JOB_TIMEOUT_MS 之内。
    max_new_tokens: int = 2048
    allow_download: bool = True
    #: text 模式的兜底指令（json 模式的指令由 build_json_prompt 现场组装，不做字段配置 ——
    #: 信封是结构性的，允许通过环境变量整体替换正是当初那个 bug 的来源）。
    default_prompt: str = "用中文简要描述这张图片的内容。"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            api_token=os.environ.get("VLM_API_TOKEN", "").strip(),
            state_dir=Path(os.environ.get("VLM_STATE_DIR", "/var/lib/vlm")).expanduser(),
            port=_env_int("VLM_SERVICE_PORT", 8000),
            eager_load=_env_bool("VLM_EAGER_LOAD", False),
            idle_unload_ms=_env_int("VLM_IDLE_UNLOAD_MS", 600_000),
            max_queue=_env_int("VLM_MAX_QUEUE", 64),
            max_upload_mb=_env_int("VLM_MAX_UPLOAD_MB", 20),
            result_ttl_ms=_env_int("VLM_RESULT_TTL_MS", 1_800_000),
            expose_trace=_env_bool("VLM_EXPOSE_TRACE", False),
            job_timeout_ms=_env_int("VLM_JOB_TIMEOUT_MS", 600_000),
            model=os.environ.get("VLM_MODEL", "Qwen/Qwen3-VL-4B-Instruct").strip()
            or "Qwen/Qwen3-VL-4B-Instruct",
            device=(os.environ.get("VLM_DEVICE", "cuda").strip() or "cuda").lower(),
            attn=(os.environ.get("VLM_ATTN", "sdpa").strip() or "sdpa").lower(),
            load_in_4bit=_env_bool("VLM_LOAD_IN_4BIT", True),
            min_pixels=_env_int("VLM_MIN_PIXELS", DEFAULT_MIN_PIXELS),
            max_pixels=_env_int("VLM_MAX_PIXELS", DEFAULT_MAX_PIXELS),
            max_new_tokens=_env_int("VLM_MAX_NEW_TOKENS", 2048),
            allow_download=_env_bool("VLM_ALLOW_DOWNLOAD", True),
            default_prompt=os.environ.get("VLM_DEFAULT_PROMPT", "").strip()
            or "用中文简要描述这张图片的内容。",
        )

    # ---- 派生路径 ----

    @property
    def images_dir(self) -> Path:
        """上传图片的落点（job 结束即随 TTL 清理）。"""
        return self.state_dir / "images"

    @property
    def out_dir(self) -> Path:
        """理解结果（JSON）的落点。"""
        return self.state_dir / "out"

    @property
    def models_dir(self) -> Path:
        """HF 权重缓存（download_root 口径，命名卷持久化）。"""
        return self.state_dir / "models"

    @property
    def registry_file(self) -> Path:
        return self.state_dir / "jobs.jsonl"

    def ensure_dirs(self) -> None:
        for path in (self.state_dir, self.images_dir, self.out_dir, self.models_dir):
            path.mkdir(parents=True, exist_ok=True)

    # ---- 引擎配置 ----

    def engine_config(self) -> dict:
        """喂给 `vlm_engine` 的配置结构（避免引擎反向依赖本模块）。"""
        return {
            "model": self.model,
            "device": self.device,
            "attn": self.attn,
            # CPU 上不做 NF4：bitsandbytes 的 4bit 主要面向 CUDA，CPU 走 bf16 更稳（见引擎注释）
            "load_in_4bit": bool(self.load_in_4bit and self.device.startswith("cuda")),
            "min_pixels": self.min_pixels,
            "max_pixels": self.max_pixels,
            "max_new_tokens": self.max_new_tokens,
            "models_dir": self.models_dir,
            "allow_download": self.allow_download,
        }

    def resolve_mode(self, requested: str | None) -> str:
        """把请求里的输出形态归一成 `json` / `text`。"""
        return normalize_mode(requested)

    def resolve_prompt(self, requested: str | None, mode: str = "json") -> str:
        """取本次要下发的指令。

        json 模式走 `build_json_prompt`：自定义要求只作为 description 的内容要求并入输出信封，
        不参与决定输出结构 —— 因此任意 prompt 都能稳定拿到结构化 JSON。
        text 模式不要求 JSON，请求给的直接生效。
        """
        value = (requested or "").strip()
        if mode == "json":
            return build_json_prompt(value)
        return value or self.default_prompt

    def resolve_idle_unload_ms(self) -> int:
        """空闲卸载阈值（ms）。非正数一律视为「不卸载」—— 负值会让间隔算成过去时间，直接归零。"""
        return self.idle_unload_ms if self.idle_unload_ms > 0 else 0

    def fingerprint(self) -> str:
        """配置指纹，便于日志里分辨「跑的是哪套参数」。"""
        idle = self.resolve_idle_unload_ms()
        return "|".join(
            [
                f"model={self.model}",
                f"device={self.device}",
                f"attn={self.attn}",
                f"4bit={self.engine_config()['load_in_4bit']}",
                f"pixels={self.min_pixels}..{self.max_pixels}",
                f"max_new={self.max_new_tokens}",
                f"idle_unload={'off' if idle == 0 else f'{idle}ms'}",
            ]
        )
