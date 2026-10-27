"""IndexTTS2 作业执行体 —— stdio worker 与 HTTP 服务共用。

从 `indextts_worker._handle_job` 抽取而来。抽出的目的：容器化后同一份推理逻辑要同时
服务两条传输（Node 子进程的 stdio、独立 GPU 服务的 HTTP），业务细节只应存在一处，
避免两边各自漂移。

保持与抽取前**行为一致**：文案解析、参考音校验（存在 + ≥100 字节）、输出目录创建、
调用 `run_index_tts_infer`。进度仍旧由 `run_index_tts_infer` 内部的 `emit()` 上报，
本模块不额外发进度，避免重复。
"""

from __future__ import annotations

from pathlib import Path

from indextts_engine import run_index_tts_infer  # noqa: E402

#: 参考音最小字节数。低于此值几乎必然是空文件或写坏的文件，早失败比让模型读到更好。
MIN_REFERENCE_BYTES = 100


def resolve_speak_text(text: str | None, text_file: str | None) -> str:
    """从「内联文本」或「文本文件」解析出待合成文案。"""
    if text_file:
        speak_text = Path(text_file).read_text(encoding="utf-8").strip()
    else:
        speak_text = str(text or "").strip()
    if not speak_text:
        raise ValueError("文案为空")
    return speak_text


def validate_reference(reference: str) -> Path:
    """校验参考音并返回其绝对路径。"""
    raw = str(reference or "").strip()
    if not raw:
        raise ValueError("缺少参考音频路径（reference）")
    ref_path = Path(raw)
    if not ref_path.is_file() or ref_path.stat().st_size < MIN_REFERENCE_BYTES:
        raise FileNotFoundError(f"参考音频不存在或无效: {raw}")
    return ref_path.resolve()


def run_job(
    tts,
    cfg: dict,
    *,
    text: str | None = None,
    text_file: str | None = None,
    output: str | Path,
    reference: str,
    speed: str = "balanced",
) -> Path:
    """执行一次合成，返回产物 wav 的绝对路径。

    `output` 由调用方决定落点：stdio 模式下是 Node 传来的绝对路径，HTTP 模式下是
    服务自管的运行期目录。
    """
    speak_text = resolve_speak_text(text, text_file)
    ref_path = validate_reference(reference)

    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    run_index_tts_infer(
        tts,
        cfg,
        speak_text=speak_text,
        output_path=output_path,
        spk_wav=str(ref_path),
        speed=speed or "balanced",
    )
    return output_path.resolve()
