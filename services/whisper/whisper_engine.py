"""本地 Whisper 推理引擎：音频 → SRT。

与 `services/indextts/indextts_engine.py` 对等 —— **只做「音频 → 字幕」**，不含任何业务
逻辑（队列、任务表、文件落库、归属校验全在 Node 业务侧）。所有路径由调用方给绝对路径，
权重落在 `download_root`（可写卷）。

实现基于 faster-whisper（CTranslate2）。调用方式与已在 JY_IPAgent 验证过的
`tools/Whisper/run_asr_timestamps.py` 保持一致：`WhisperModel(model, device, compute_type,
download_root)` + `vad_filter=True`，差别只在于这里额外产出 SRT 并在转写过程中上报进度。
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Callable

#: 进度回调：(pct 0..1, stage) —— stage 只用 ASCII key，中文标签在 Node 侧拼装
ProgressFn = Callable[[float, str], None]

#: 音频字节下限。低于此值必然是空文件/损坏文件，交给引擎只会拿到难懂的报错
MIN_AUDIO_BYTES = 1024

#: 二次切分用的标点：句末与句读**都**是断点（严格按标点切，见 split_long_text）
_SENTENCE_END = "。！？!?…；;"
_CLAUSE_END = "，,、：:"

#: 半角 → 全角标点。仅在中文语境里替换（见 normalize_punctuation），
#: 所以 `3.5` / `1,000` / `http://` 这类拉丁语境里的符号不受影响。
_HALF_TO_FULL = {",": "，", ".": "。", "?": "？", "!": "！", ";": "；", ":": "："}

#: 中文（基本区 + 扩展 A + 兼容区）：判断标点是否处在中文语境里
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

#: 拉丁/数字「词内」字符：半角 `,` `:` 夹在它们中间时不算断点，
#: 否则 `1,000`、`http://a.b/c` 会被切成两段（同时也不该被当成标点丢掉）。
_TOKEN_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._%-+")

_WHITESPACE = re.compile(r"\s+")


def configure_hf_mirror() -> None:
    """优先国内 HF 镜像。

    必须在 `import faster_whisper`（进而 import huggingface_hub）**之前**调用才生效 ——
    hub 在模块导入期读取 `HF_ENDPOINT`。故由 `load_model()` 负责先调它再 import。
    容器里 Dockerfile 也设了同名环境变量，这里是宿主直接跑 CLI 时的兜底。
    """
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HUGGINGFACE_HUB_ENDPOINT", "https://hf-mirror.com")
    # 必须关掉 Xet：hf-mirror 只代理了 HF 的元数据/文件接口，**没有**代理 Xet 的 CAS 存储
    # （cas-server.xethub.hf.co），走 Xet 会 401 Unauthorized 而整体下载失败。
    # 关掉后 hub 回退到普通 HTTP 下载，镜像路径才可用。
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def preload_cuda_libraries() -> list[str]:
    """把 pip 安装的 `nvidia-*-cu12` 动态库以 RTLD_GLOBAL 预加载。

    为什么必须显式预加载：CTranslate2 通过 dlopen 查找 `libcublas.so.12` / `libcudnn.so.9`，
    而只在系统默认搜索路径里找；pip 的 nvidia 包把它们放在
    `site-packages/nvidia/<lib>/lib/`，不在默认路径上。又因为 `LD_LIBRARY_PATH` 是**进程启动时**
    由动态链接器读取的，在 Python 里改 `os.environ` 对已经跑起来的进程无效 —— 所以这里直接
    把库 load 进来（`RTLD_GLOBAL` 让后续 dlopen 能解析到其中的符号）。

    返回成功预加载的库文件名，便于日志排查。失败静默容忍：容器若用带 cuDNN 的基础镜像，
    系统路径本来就能找到，不需要这一步。
    """
    loaded: list[str] = []
    try:
        import ctypes
        import nvidia  # pip 的 nvidia-*-cu12 都是这个 namespace 下的子包
    except Exception:
        return loaded

    # nvidia 是 **namespace package**（无 __init__.py），`__file__` 为 None，必须用 __path__
    candidates = list(getattr(nvidia, "__path__", None) or [])
    if not candidates:
        file = getattr(nvidia, "__file__", None)
        if file:
            candidates = [str(Path(file).resolve().parent)]
    if not candidates:
        return loaded
    base = Path(candidates[0])
    # 两轮：先尽力加载（顺序不保证满足依赖），再补一轮拿到第一轮里因依赖未就绪而失败的。
    # 依赖关系（如 libcublas 依赖 libcublasLt）决定了单轮不保证全部成功。
    for _ in range(2):
        for lib in sorted(base.glob("*/lib/lib*.so*")):
            if lib.name in loaded or lib.name.split(".so")[0] + ".so" in loaded:
                continue
            try:
                ctypes.CDLL(str(lib), mode=ctypes.RTLD_GLOBAL)
                loaded.append(lib.name)
            except OSError:
                continue
    return loaded


def configure_runtime() -> list[str]:
    """引擎侧的进程级初始化：HF 镜像 + CUDA 库预加载。返回预加载的库列表。"""
    configure_hf_mirror()
    return preload_cuda_libraries()


def _emit(on_progress: ProgressFn | None, pct: float, stage: str) -> None:
    if on_progress is None:
        return
    try:
        on_progress(pct, stage)
    except Exception:
        # 进度上报永远不能影响推理本身
        pass


def normalize_punctuation(text: str) -> str:
    """半角标点 → 全角，**仅当该标点与中文相邻**。

    不做无脑全量替换：`3.5` / `1,000` / `http://` 里的 `. , :` 必须原样保留，否则数字与
    URL 会被改坏。只有前一个或后一个字符是中文时才转换 —— `同一套产品,` → `同一套产品，`、
    `在哪?` → `在哪？`。

    目的：模型输出的标点半角/全角混排，既难看，也让「按标点断句」的判定与展示不一致。
    """
    if not text:
        return text
    chars = list(text)
    last = len(text) - 1
    for i, ch in enumerate(text):
        full = _HALF_TO_FULL.get(ch)
        if not full:
            continue
        prev_ch = text[i - 1] if i > 0 else ""
        next_ch = text[i + 1] if i < last else ""
        if _CJK.match(prev_ch) or _CJK.match(next_ch):
            chars[i] = full
    return "".join(chars)


def normalize_text(text: str) -> str:
    """去空白（中文转写不需要词间空格，SRT 行内也不该有换行）+ 标点半角归一化。"""
    return normalize_punctuation(_WHITESPACE.sub("", text or "").strip())


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------


def _slug(model: str) -> str:
    """`Systran/faster-whisper-large-v3` / `large-v3` → `large-v3`（小写，用于缓存命中判断）。"""
    return model.split("/")[-1].strip().lower()


def _cached_model_bins(download_root: Path) -> list[Path]:
    """已缓存的 faster-whisper 权重文件（HF 缓存布局：models--<org>--<name>/snapshots/<rev>/model.bin）。"""
    if not download_root.is_dir():
        return []
    return sorted(download_root.glob("models--*--faster-whisper-*/snapshots/*/model.bin"))


def local_model_present(model: str, download_root: Path) -> bool:
    """模型是否已在 `download_root` 落地（仅用于 `allow_download=false` 的前置校验与状态展示）。"""
    slug = _slug(model)
    return any(slug in str(path.parents[2].name).lower() for path in _cached_model_bins(download_root))


def readiness_report(cfg: dict) -> dict:
    """权重落地情况。供 `/readyz` 之外的诊断接口与缺失清单使用，**不加载模型**。"""
    download_root = Path(cfg["download_root"])
    model = str(cfg.get("model") or "large-v3")
    bins = _cached_model_bins(download_root)
    return {
        "model": model,
        "device": str(cfg.get("device") or "cuda"),
        "compute_type": str(cfg.get("compute_type") or "float16"),
        "download_root": str(download_root),
        "present": local_model_present(model, download_root),
        "cached": sorted({path.parents[2].name for path in bins}),
    }


def load_model(cfg: dict, on_progress: ProgressFn | None = None):
    """加载 faster-whisper 模型。

    首次加载会从 `HF_ENDPOINT` 拉取权重（large-v3 约 3GB），此后命中缓存。
    `allow_download=false` 时先做落地校验并抛出**可读的**缺失清单，避免在用户请求里
    悄悄触发数 GB 下载。
    """
    loaded = configure_runtime()
    if loaded:
        # 便于排障：确认 cuBLAS/cuDNN 是从 pip 包预加载的（而非系统路径）
        print(f"[whisper] preloaded {len(loaded)} CUDA lib(s): {', '.join(loaded[:6])}", file=sys.stderr, flush=True)

    model = str(cfg.get("model") or "large-v3")
    device = str(cfg.get("device") or "cuda")
    compute_type = str(cfg.get("compute_type") or "float16")
    download_root = Path(cfg["download_root"])
    allow_download = bool(cfg.get("allow_download", True))
    download_root.mkdir(parents=True, exist_ok=True)

    if not allow_download and not local_model_present(model, download_root):
        report = readiness_report(cfg)
        raise RuntimeError(
            "Whisper 权重未就绪且禁止自动下载（WHISPER_ALLOW_DOWNLOAD=false）。\n"
            f"  模型：{model}\n"
            f"  下载目录：{report['download_root']}\n"
            f"  已缓存：{report['cached'] or '无'}\n"
            "请在能联网的机器上预下载后同步进挂载卷，或改 WHISPER_ALLOW_DOWNLOAD=true。"
        )

    _emit(on_progress, 0.15, "whisper_load")

    # 延迟 import：让 configure_hf_mirror() 先于 huggingface_hub 读取环境变量
    from faster_whisper import WhisperModel

    instance = WhisperModel(
        model,
        device=device,
        compute_type=compute_type,
        download_root=str(download_root),
    )
    _emit(on_progress, 0.30, "whisper_ready")
    return instance


# ---------------------------------------------------------------------------
# 转写
# ---------------------------------------------------------------------------


def transcribe(
    model,
    audio_path: str | Path,
    *,
    language: str | None = None,
    beam_size: int = 5,
    vad_filter: bool = True,
    on_progress: ProgressFn | None = None,
) -> tuple[list[dict], float]:
    """转写音频，返回 `(segments, duration_sec)`。

    `model.transcribe()` 返回的 segments 是**生成器** —— 推理是按需推进的，必须真正迭代
    消费才会开始计算。这正好让我们能在消费过程中按 `seg.end / duration` 上报进度。

    刻意不取 `word_timestamps`：本服务的产物是**最终字幕**（Node 侧直接落 SRT），
    词级时间戳除了拖慢推理之外没有用处（那套逻辑只服务于讯飞锚点映射）。
    """
    segments_iter, info = model.transcribe(
        str(Path(audio_path).resolve()),
        language=language or None,
        beam_size=max(1, int(beam_size)),
        vad_filter=bool(vad_filter),
        word_timestamps=False,
    )

    duration = float(getattr(info, "duration", 0.0) or 0.0)
    out: list[dict] = []
    for seg in segments_iter:
        text = normalize_text(getattr(seg, "text", "") or "")
        if text:
            start = float(getattr(seg, "start", 0.0) or 0.0)
            end = float(getattr(seg, "end", start) or start)
            out.append(
                {
                    "index": len(out) + 1,
                    "start": start,
                    "end": max(end, start + 0.2),
                    "text": text,
                }
            )
        if duration > 0:
            _emit(on_progress, min(0.99, max(0.0, float(getattr(seg, "end", 0.0) or 0.0) / duration)), "whisper_transcribe")

    return out, duration


# ---------------------------------------------------------------------------
# SRT
# ---------------------------------------------------------------------------


def format_srt_time(seconds: float) -> str:
    """秒 → `HH:MM:SS,mmm`（毫秒，与讯飞解析链路口径一致）。"""
    total_ms = max(0, int(round(seconds * 1000)))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _is_break(text: str, i: int) -> bool:
    """下标 i 处的字符是否作为断句标点（是则它只决定切点，自身不进产物）。

    半角 `,` `:` 额外做一次「词内」判定：`1,000` / `http://a.b/c` 里的符号不是标点，
    既不该断句也不该被丢掉。
    """
    ch = text[i]
    if ch not in _SENTENCE_END and ch not in _CLAUSE_END:
        return False
    if ch in ",:":
        prev_ch = text[i - 1] if i > 0 else ""
        next_ch = text[i + 1] if i + 1 < len(text) else ""
        if prev_ch in _TOKEN_CHARS and next_ch in _TOKEN_CHARS:
            return False
    return True


def split_long_text(text: str, max_chars: int) -> list[str]:
    """把一段转写文本切成多条字幕：**严格按标点切分，且产物不带标点**。

    规则（自上而下）：
    ① 每个标点都是断点 —— 句末（。！？…；）与句读（，、：）一视同仁，即
       「一条字幕 = 两个标点之间的一段话」（`在A客户三个月上线，在B客户拖了一年。` → 两条）；
    ② **标点只决定切点、不进产物**：`。！？…；，、：` 以及处于中文语境的半角同类符号都删掉；
       而 `1,000` / `http://a.b/c` 里夹在数字/字母中的半角符号不视为标点，原样保留；
    ③ 整段一个标点都没有时，才在 max_chars 处硬切兜底（否则无标点长串会顶满整屏）。

    与前一版实现的区别：那一版只在「长度达到 max_chars 之后」才认标点，于是
    `在A客户三个月上线，在B客户拖了一年。`（两个小句）会被粘成一条 18 字字幕。
    """
    text = (text or "").strip()
    if not text:
        return []
    # max_chars <= 0（未设上限）时仍按标点切，只是不再做长度兜底
    return _split_body(text, max_chars)


def _split_body(text: str, max_chars: int) -> list[str]:
    """逐字切分：标点处断开且丢弃该标点；无标点超过 max_chars 则硬切兜底。"""
    pieces: list[str] = []
    buf = ""
    for i, ch in enumerate(text):
        if _is_break(text, i):
            if buf:
                pieces.append(buf)
                buf = ""
            continue
        buf += ch
        if max_chars > 0 and len(buf) > max_chars:
            pieces.append(buf[:max_chars])
            buf = buf[max_chars:]
    if buf:
        pieces.append(buf)
    return pieces


def build_cues(segments: list[dict], *, max_chars: int = 20) -> list[dict]:
    """segment → cues：按字数比例把该段的时间区间分给切分后的各行。"""
    cues: list[dict] = []
    for seg in segments:
        pieces = split_long_text(str(seg.get("text") or ""), max_chars)
        if not pieces:
            continue
        start = float(seg.get("start") or 0.0)
        end = max(float(seg.get("end") or start), start + 0.2)
        total_chars = sum(len(p) for p in pieces) or 1
        span = max(0.2, end - start)

        cursor = start
        for i, piece in enumerate(pieces):
            piece_end = end if i == len(pieces) - 1 else cursor + span * (len(piece) / total_chars)
            cues.append(
                {
                    "index": len(cues) + 1,
                    "start": round(cursor, 3),
                    "end": round(max(cursor + 0.2, piece_end), 3),
                    "text": piece,
                }
            )
            cursor = piece_end
    return cues


def cues_to_srt(cues: list[dict]) -> str:
    """cues → SRT 文本。空 cues 返回空串（Node 侧据此判失败）。"""
    blocks: list[str] = []
    for cue in cues:
        text = str(cue.get("text") or "").strip()
        if not text:
            continue
        blocks.append(
            f"{len(blocks) + 1}\n"
            f"{format_srt_time(float(cue.get('start') or 0.0))} --> "
            f"{format_srt_time(float(cue.get('end') or 0.0))}\n"
            f"{text}"
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def transcribe_to_srt(
    model,
    audio_path: str | Path,
    *,
    language: str | None = None,
    beam_size: int = 5,
    vad_filter: bool = True,
    max_chars: int = 20,
    on_progress: ProgressFn | None = None,
) -> tuple[str, dict]:
    """一步到位：音频 → SRT 文本 + 统计信息（`duration_sec` / `cue_count`）。"""
    segments, duration = transcribe(
        model,
        audio_path,
        language=language,
        beam_size=beam_size,
        vad_filter=vad_filter,
        on_progress=on_progress,
    )
    cues = build_cues(segments, max_chars=max_chars)
    srt = cues_to_srt(cues)
    return srt, {"duration_sec": round(duration, 3), "cue_count": len(cues)}
