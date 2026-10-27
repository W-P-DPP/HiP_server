"""One-shot IndexTTS2 clone inference (fallback when the warm worker is unavailable).

    <indextts venv python> run_indextts.py --config <config.json> \
        --output <out.wav> --reference <ref.wav> --text "..." [--speed balanced]

每次调用都会重新加载模型（1–3 分钟），因此这是**正确性**兜底而非性能方案。
stdout 与 worker 采用同一套 @@PROGRESS@@ / 末行 JSON 协议。

移植自 JY_IPAgent 的 tts/run_indextts.py。
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from indextts_engine import create_index_tts2, load_config, run_index_tts_infer  # noqa: E402
from progress import emit  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="IndexTTS2 one-shot clone inference")
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--text")
    parser.add_argument("--text-file")
    parser.add_argument("--speed", default="balanced")
    args = parser.parse_args()

    try:
        if args.text_file:
            speak_text = Path(args.text_file).read_text(encoding="utf-8").strip()
        elif args.text:
            speak_text = args.text.strip()
        else:
            parser.error("需要 --text 或 --text-file")
            return

        ref_path = Path(args.reference)
        if not ref_path.is_file() or ref_path.stat().st_size < 100:
            raise FileNotFoundError(f"参考音频不存在或无效: {args.reference}")

        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)

        emit(0.05, "config")
        cfg = load_config(args.config)
        emit(0.10, "indextts_load")
        print("[indextts] loading model…", file=sys.stderr, flush=True)
        tts = create_index_tts2(cfg)
        emit(0.14, "indextts_ready")

        run_index_tts_infer(
            tts,
            cfg,
            speak_text=speak_text,
            output_path=output,
            spk_wav=str(ref_path.resolve()),
            speed=args.speed,
        )
        print(json.dumps({"ok": True, "raw_audio": str(output.resolve())}), flush=True)
    except BaseException as exc:  # noqa: BLE001 — 必须把失败原因通过协议回给 Node
        print(f"[indextts] one-shot failed: {exc}", file=sys.stderr, flush=True)
        print(
            json.dumps({"ok": False, "error": str(exc), "trace": traceback.format_exc()}, ensure_ascii=False),
            flush=True,
        )
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
