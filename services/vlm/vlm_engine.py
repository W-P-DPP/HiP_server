"""本地 Qwen3-VL 推理引擎：图片字节 → 结构化 JSON（或自由文本）。

与 `services/whisper/whisper_engine.py` 对等 —— **只做「图片 → 文字」**，不含任何业务逻辑
（队列、任务表、文件落库、归属校验全在 Node 业务侧）。所有路径由调用方给绝对路径，
权重落在 `models_dir`（可写卷）。

实现基于 transformers 的 `Qwen3VLForConditionalGeneration` + bitsandbytes NF4。
Qwen3-VL 于 2025-09-15 合入 transformers，**4.57.0 是支持下限**。
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Callable

#: 进度回调：(pct 0..1, stage) —— stage 只用 ASCII key，中文标签在 Node 侧拼装
ProgressFn = Callable[[float, str], None]

#: 图片字节下限。低于此值必然是空文件/损坏文件，交给引擎只会拿到难懂的报错
MIN_IMAGE_BYTES = 512

#: 首次 JSON 解析失败后追加的提醒，用于第二次尝试（见 server.py 的重试逻辑）。
#:
#: 措辞针对两类**实测**失败：
#: ① 压根没输出 JSON（套了 markdown 围栏、或在 JSON 后面补一段解释）；
#: ② 输出了合法 JSON 但**改了字段名**（实测见过把 description 写成 image_description、
#:    并丢掉其它字段）—— 容器只判「能否解析成对象」，改名字段它看不出来，会判成功，
#:    最终由 Node 侧的 normalizeVlmResult 拦下（报"缺少 description"）。所以这里要专门
#:    点一句「字段名照抄上文」，把这类失败挡在第一轮重试里。
STRICT_REMINDER = (
    "\n\n上次回答无法被解析为 JSON。请重新回答，并且严格遵守：\n"
    "1. **只输出一个 JSON 对象**：不要 markdown 代码块、不要任何解释文字、不要前后缀，"
    "第一个字符必须是 {，最后一个必须是 }。\n"
    "2. **字段名必须与上文要求的完全一致**：一个不多、一个不少，不要改名、不要翻译、"
    "不要新增同义字段（例如把 description 写成 image_description 是不允许的）。\n"
    "3. 无法判断的字段给空数组或 \"other\"，仍然必须出现。"
)

#: ```json ... ``` 围栏（模型最常见的「多此一举」）
_FENCE = re.compile(r"```[ \t]*(?:json)?[ \t]*\r?\n?(.*?)```", re.DOTALL | re.IGNORECASE)


def configure_hf_mirror() -> None:
    """优先国内 HF 镜像。

    必须在 `import transformers`（进而 import huggingface_hub）**之前**调用才生效 ——
    hub 在模块导入期读取 `HF_ENDPOINT`。故由 `load_model()` 负责先调它再 import。
    容器里 Dockerfile 也设了同名环境变量，这里是宿主直接跑 CLI 时的兜底。
    """
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HUGGINGFACE_HUB_ENDPOINT", "https://hf-mirror.com")
    # 必须关掉 Xet：hf-mirror 只代理了 HF 的元数据/文件接口，**没有**代理 Xet 的 CAS 存储
    # （cas-server.xethub.hf.co），走 Xet 会 401 Unauthorized 而整体下载失败。
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def _emit(on_progress: ProgressFn | None, pct: float, stage: str) -> None:
    if on_progress is None:
        return
    try:
        on_progress(pct, stage)
    except Exception:
        # 进度上报永远不能影响推理本身
        pass


# ---------------------------------------------------------------------------
# 权重落地检查（不加载模型）
# ---------------------------------------------------------------------------


def _model_dir_name(model_id: str) -> str:
    """`Qwen/Qwen3-VL-4B-Instruct` → `models--Qwen--Qwen3-VL-4B-Instruct`（HF 缓存布局）。"""
    return "models--" + model_id.strip().replace("/", "--")


def _snapshot_dirs(model_id: str, models_dir: Path) -> list[Path]:
    """该模型在 HF 缓存里的全部 snapshot 目录。"""
    base = models_dir / _model_dir_name(model_id)
    if not base.is_dir():
        return []
    return sorted(p for p in base.glob("snapshots/*") if p.is_dir())


def _snapshot_complete(snapshot: Path) -> bool:
    """snapshot 是否已可用：config.json + 至少一个权重分片。"""
    if not (snapshot / "config.json").is_file():
        return False
    return any(snapshot.glob("*.safetensors")) or any(snapshot.glob("*.bin"))


def local_model_present(model_id: str, models_dir: Path) -> bool:
    """模型是否已在 `models_dir` 落地（`allow_download=false` 的前置校验与状态展示用）。"""
    return any(_snapshot_complete(s) for s in _snapshot_dirs(model_id, models_dir))


def _dir_bytes(path: Path) -> int:
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
        except OSError:
            continue
    return total


def readiness_report(cfg: dict) -> dict:
    """权重落地情况。供 `/readyz` 之外的诊断接口与缺失清单使用，**不加载模型**。"""
    models_dir = Path(cfg["models_dir"])
    model_id = str(cfg.get("model") or "")
    snapshots = _snapshot_dirs(model_id, models_dir)
    usable = [s for s in snapshots if _snapshot_complete(s)]
    return {
        "model": model_id,
        "device": str(cfg.get("device") or "cuda"),
        "load_in_4bit": bool(cfg.get("load_in_4bit", True)),
        "models_dir": str(models_dir),
        "present": bool(usable),
        "cached": [p.name for p in snapshots],
        "size_bytes": _dir_bytes(usable[-1]) if usable else 0,
    }


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------


def load_model(cfg: dict, on_progress: ProgressFn | None = None) -> dict:
    """加载 Qwen3-VL 模型与处理器。

    首次加载会从 `HF_ENDPOINT` 拉取权重（4bit 量化后约 3GB），此后命中缓存。
    `allow_download=false` 时先做落地校验并抛出**可读的**缺失清单，避免在用户请求里
    悄悄触发数 GB 下载。

    返回引擎句柄 dict（model / processor / model_id / device / load_ms）。
    """
    configure_hf_mirror()

    model_id = str(cfg.get("model") or "")
    device = str(cfg.get("device") or "cuda").lower()
    attn = str(cfg.get("attn") or "sdpa").lower()
    use_4bit = bool(cfg.get("load_in_4bit", True))
    min_pixels = int(cfg.get("min_pixels") or 0) or None
    max_pixels = int(cfg.get("max_pixels") or 0) or None
    models_dir = Path(cfg["models_dir"])
    allow_download = bool(cfg.get("allow_download", True))
    models_dir.mkdir(parents=True, exist_ok=True)

    if not allow_download and not local_model_present(model_id, models_dir):
        report = readiness_report(cfg)
        raise RuntimeError(
            "Qwen3-VL 权重未就绪且禁止自动下载（VLM_ALLOW_DOWNLOAD=false）。\n"
            f"  模型：{report['model']}\n"
            f"  下载目录：{report['models_dir']}\n"
            f"  已缓存：{report['cached'] or '无'}\n"
            "请在能联网的机器上预下载后同步进挂载卷，或改 VLM_ALLOW_DOWNLOAD=true。"
        )

    _emit(on_progress, 0.10, "vlm_load")

    # 延迟 import：让 configure_hf_mirror() 先于 huggingface_hub 读取环境变量
    import torch
    from transformers import AutoProcessor, BitsAndBytesConfig, Qwen3VLForConditionalGeneration

    started = time.time()
    print(
        f"[vlm] loading model={model_id} device={device} attn={attn} 4bit={use_4bit} "
        f"pixels={min_pixels}..{max_pixels}",
        file=sys.stderr,
        flush=True,
    )

    kwargs: dict = {"attn_implementation": attn}

    if use_4bit:
        # NF4 + 双重量化：显存最省的一档，4B 模型权重压到约 3GB。
        # compute dtype 用 bf16 —— fp16 在长上下文下容易溢出。
        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
        # 显式单卡：让装不下时**直接报 OOM**，而不是被 device_map="auto" 静默 offload 到
        # CPU 上变成几十倍慢 —— 后者更难排查，且会让人误以为「跑得动」。
        kwargs["device_map"] = {"": "cuda:0"} if device.startswith("cuda") else {"": "cpu"}
    else:
        # 非 4bit 路径（CPU 兜底 / 需要更高精度时）：bf16 权重约 10GB，显存与内存都要够
        kwargs["dtype"] = torch.bfloat16
        kwargs["device_map"] = {"": "cuda:0"} if device.startswith("cuda") else {"": "cpu"}

    # cache_dir 必须显式给：默认会落到 HF 的 `~/.cache/huggingface/hub`，也就是**容器的可写层**，
    # 而不是 compose 挂的 vlm-state 命名卷 —— 那样每次容器重建（compose 改一行就会重建）都要
    # 重新下载约 9GB，而且 readiness_report 查的 models_dir 永远是空的（present 恒为 false，
    # VLM_ALLOW_DOWNLOAD=false 的守卫也会误判成"权重缺失"）。
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        model_id,
        cache_dir=str(models_dir),
        **kwargs,
    )
    _emit(on_progress, 0.25, "vlm_load")

    # min/max_pixels 传给图像处理器，直接决定视觉 token 数（见 README 的显存说明）
    processor = AutoProcessor.from_pretrained(
        model_id,
        cache_dir=str(models_dir),
        min_pixels=min_pixels,
        max_pixels=max_pixels,
    )

    load_ms = int((time.time() - started) * 1000)
    _emit(on_progress, 0.30, "vlm_ready")
    return {
        "model": model,
        "processor": processor,
        "model_id": model_id,
        "device": device,
        "load_in_4bit": use_4bit,
        "load_ms": load_ms,
    }


# ---------------------------------------------------------------------------
# 推理
# ---------------------------------------------------------------------------


def build_inputs(processor, image_path: str | Path, prompt: str):
    """图片 + 指令 → 模型输入张量。

    messages 的结构与 Qwen3-VL 官方用法一致（`apply_chat_template` 自己会去读图）。
    路径给**纯绝对路径**、不要加 `file://` 前缀：处理器的图片加载只认 http(s) URL 与
    本地文件路径两种形式，带协议前缀的本地路径会被当成后者而打不开。
    """
    abs_path = str(Path(image_path).resolve())
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": abs_path},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    return processor.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        return_dict=True,
        return_tensors="pt",
    )


def generate(engine: dict, inputs, *, max_new_tokens: int) -> tuple[str, bool]:
    """贪心生成，返回 `(文本, 是否被 max_new_tokens 截断)`。

    `do_sample=False` 是刻意的：结构化抽取要的是可复现，同一张图两次跑出不同字段名
    对下游是纯负担。

    为什么要回传「是否截断」：截断会让 JSON **缺收尾的引号与花括号**，从解析层看就是
    「模型没产出可解析的 JSON」—— 实测为此把排查方向带偏过。生成 token 数正好顶到上限，
    就说明是**我们把它切断了**，而不是模型不会输出，这两者的处理方式完全不同。

    （判据是「生成数 ≥ 上限」而不是「最后一个 token 不是 EOS」：后者要处理各模型的
    EOS 配置差异，而顶到上限本身就足以判定是外部截断。）
    """
    import torch

    model = engine["model"]
    processor = engine["processor"]

    device = next(model.parameters()).device
    inputs = inputs.to(device)

    with torch.inference_mode():
        generated = model.generate(
            **inputs,
            max_new_tokens=max(1, int(max_new_tokens)),
            do_sample=False,
        )

    input_len = inputs["input_ids"].shape[-1]
    trimmed = generated[:, input_len:]
    hit_limit = int(trimmed.shape[-1]) >= max(1, int(max_new_tokens))
    decoded = processor.batch_decode(
        trimmed,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )
    return (decoded[0] if decoded else "").strip(), hit_limit


def strip_code_fence(text: str) -> str:
    """剥掉 ```json ... ``` 围栏。没有围栏时原样返回。"""
    if not text:
        return ""
    match = _FENCE.search(text)
    if match:
        return match.group(1)
    return text


def first_json_span(text: str) -> tuple[int, int] | None:
    """从左往右找第一个**括号配平**的 JSON 对象区间。

    刻意不用「第一个 { 到最后一个 }」那种偷懒写法：模型爱在 JSON 后面补一句解释，
    甚至再附一个示例对象，那样切出来的跨度里夹着中英文，json.loads 必然失败。
    这里逐字符走一遍并跟踪字符串状态，保证花括号落在字符串内部时不被计数 ——
    否则描述文本里的 `}`（比如「他说：}」）会提前截断。

    返回 (start, end)（含端点），没有配平的对象时返回 None。
    """
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return start, i
        start = text.find("{", start + 1)
    return None


def parse_json_object(text: str) -> dict | None:
    """从模型输出里抠出第一个可解析的 JSON 对象；失败返回 None（不抛）。"""
    if not text:
        return None
    body = strip_code_fence(text)
    span = first_json_span(body)
    if span is None:
        return None
    try:
        parsed = json.loads(body[span[0] : span[1] + 1])
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def understand(
    engine: dict,
    image_path: str | Path,
    prompt: str,
    *,
    max_new_tokens: int = 256,
    on_progress: ProgressFn | None = None,
) -> dict:
    """一次理解调用。返回 `{text, json, elapsed_ms, truncated}`。

    `json` 只在「模型确实产出了可解析对象」时非空；解析成功与否由调用方（server.py）
    决定是否重试、以及最终算不算任务成功 —— 引擎本身不替业务下判断。

    `truncated` 表示这次生成顶到了 `max_new_tokens`（见 `generate` 的说明）：调用方应据此
    把「JSON 不完整」归因到长度上限，而不是笼统地说模型没按格式输出。
    """
    started = time.time()
    _emit(on_progress, 0.45, "vlm_generate")
    inputs = build_inputs(engine["processor"], image_path, prompt)
    text, truncated = generate(engine, inputs, max_new_tokens=max_new_tokens)
    _emit(on_progress, 0.88, "vlm_parse")
    return {
        "text": text,
        "json": parse_json_object(text),
        "elapsed_ms": int((time.time() - started) * 1000),
        "truncated": truncated,
    }
