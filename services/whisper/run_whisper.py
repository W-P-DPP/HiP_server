"""宿主验证 CLI：音频 → SRT，不依赖 HTTP 服务。

用途：**在 docker 之前**先在本机确认三件事 —— venv 依赖装好、模型能落地、GPU 可用。
对应 `services/indextts/run_indextts.py` 的角色（那边用于 worker 崩溃后的一次性兜底）。

示例：
    engine/.venv/bin/python run_whisper.py --audio /path/a.mp3 --language zh --out /tmp/a.srt
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from whisper_engine import load_model, readiness_report, transcribe_to_srt  # noqa: E402


def _progress(pct: float, stage: str) -> None:
    # 进度一律走 stderr，保证 stdout 只有最终的 SRT
    print(f"[run_whisper] {stage} {pct:.2f}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Whisper 音频转字幕（宿主验证用）")
    parser.add_argument("--audio", required=True, help="待转写音频路径")
    parser.add_argument("--out", default="", help="SRT 输出路径；留空则打印到 stdout")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda", help="cuda / cpu")
    parser.add_argument("--compute-type", default="float16", help="float16 / int8 / int8_float16")
    parser.add_argument("--language", default="zh", help="语种；auto 表示自动检测")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--max-chars", type=int, default=20, help="单条字幕的字符上限")
    parser.add_argument("--download-root", default="", help="权重缓存目录；默认 <本目录>/engine/models")
    parser.add_argument(
        "--allow-download",
        default="true",
        choices=("true", "false"),
        help="权重缺失时是否允许自动下载",
    )
    args = parser.parse_args()

    audio = Path(args.audio).expanduser()
    if not audio.is_file():
        raise SystemExit(f"音频不存在: {audio}")

    download_root = (
        Path(args.download_root).expanduser()
        if args.download_root
        else Path(__file__).resolve().parent / "engine" / "models"
    )

    cfg = {
        "model": args.model,
        "device": args.device,
        "compute_type": args.compute_type,
        "download_root": download_root,
        "allow_download": args.allow_download == "true",
        "beam_size": args.beam_size,
        "vad_filter": True,
        "max_chars": args.max_chars,
    }

    language = args.language.strip()
    if language.lower() in ("", "auto", "autodialect"):
        language = None

    print(f"[run_whisper] cfg={cfg}", file=sys.stderr)
    print(f"[run_whisper] weights={readiness_report(cfg)}", file=sys.stderr)

    model = load_model(cfg, _progress)
    srt, stats = transcribe_to_srt(
        model,
        audio,
        language=language,
        beam_size=args.beam_size,
        max_chars=args.max_chars,
        on_progress=_progress,
    )

    if not srt.strip():
        raise SystemExit("未识别到有效字幕，请确认音频包含清晰人声")

    print(f"[run_whisper] done cues={stats['cue_count']} audio_sec={stats['duration_sec']}", file=sys.stderr)
    if args.out:
        out = Path(args.out).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(srt, encoding="utf-8")
        print(f"[run_whisper] wrote {out}", file=sys.stderr)
    else:
        print(srt)


if __name__ == "__main__":
    main()
