"""Progress reporting for the IndexTTS2 worker.

子进程只输出 ASCII 阶段 key（避免 Windows 编码问题），中文标签由 Node 侧
`utils/constant/indextts.ts` 映射。移植自 JY_IPAgent 的 tts/progress.py，只保留
本场景用得到的部分。
"""

from __future__ import annotations

import re
from typing import Callable

MARKER = "@@PROGRESS@@"

_SEG_RE = re.compile(r"seg=(\d+)/(\d+)")
_AUDIO_RE = re.compile(r"audio=([\d.]+)")

# 进度汇：emit() 在打完 stdout 标记后逐个转发。stdio 模式不注册任何 sink，
# HTTP 模式注册一个把 marker 转成 job 进度的回调。用列表而非单个回调，
# 是为了让同一进程里可能存在多个订阅方（例如将来的指标采集）。
_sinks: list[Callable[..., None]] = []


def add_sink(fn: Callable[..., None]) -> None:
    """注册进度汇。签名须为 fn(pct, stage_key, *, seg=None, audio_sec=None)。"""
    _sinks.append(fn)


def clear_sinks() -> None:
    """注销全部进度汇（测试用）。"""
    _sinks.clear()


def estimate_speech_seconds(text: str, *, chars_per_sec: float = 4.2) -> float:
    """Rough speech duration from character count (Mandarin / Latin / mixed)."""
    raw = text or ""
    compact = re.sub(r"\s+", "", raw)
    if not compact:
        return 0.0

    cjk = sum(1 for c in compact if 0x4E00 <= ord(c) <= 0x9FFF)
    latin = sum(1 for c in compact if c.isascii() and c.isalpha())
    digits = sum(1 for c in compact if c.isdigit())
    other = max(0, len(compact) - cjk - latin - digits)

    if cjk == 0 and latin > 0:
        return latin / 12.0 + digits / 5.0 + other / 8.0

    # Mixed or Chinese-heavy: English tokens are spoken faster per character.
    return cjk / chars_per_sec + latin / 12.0 + digits / 5.0 + other / chars_per_sec


def emit(
    pct: float,
    stage_key: str,
    *,
    seg: tuple[int, int] | None = None,
    audio_sec: float | None = None,
) -> None:
    """Print one progress marker line to stdout (flushed; must not be buffered).

    stdout 标记始终保留 —— 它是既有排障习惯（`grep @@PROGRESS@@`）与日志巡检的载体，
    HTTP 模式下同样如此。转发给 sink 是附加行为，失败绝不影响标记输出。
    """
    parts = [MARKER, f"{pct:.3f}", stage_key]
    if seg and seg[1] > 0:
        parts.append(f"seg={seg[0]}/{seg[1]}")
    if audio_sec is not None:
        parts.append(f"audio={audio_sec:.1f}")
    print(" ".join(parts), flush=True)

    for fn in _sinks:
        try:
            fn(float(pct), stage_key, seg=seg, audio_sec=audio_sec)
        except Exception:
            # 进度上报失败不该中断合成本身
            pass
