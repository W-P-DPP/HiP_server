"""IndexTTS2 warm worker — load the model once, serve synthesis jobs over stdio.

由 Node 侧 `utils/indextts/IndexttsWorker.ts` 拉起：

    <indextts venv python> -u indextts_worker.py --config <config.json> --stdio

协议（逐行 JSON，stdout 通道必须保持干净，日志一律走 stderr）：

  启动  → 若干 @@PROGRESS@@ 行，然后 {"ready": true, "backend": "indextts2-worker"}
  任务  → stdin 一行 {"text"|"text_file", "output", "reference", "speed"}
        → 若干 @@PROGRESS@@ 行，然后 {"ok": true, "raw_audio": "<abs>"}
          或 {"ok": false, "error": "...", "trace": "..."}
  ping  → {"pong": true}
  退出  → shutdown → {"shutdown": true} 后结束循环

移植自 JY_IPAgent 的 tts/indextts_worker.py。相对上游的变化：
- 去掉启动时自动 `pip install pyyaml` 的副作用（生产环境不允许联网装依赖）。
- 配置改读 JSON，不再需要 PyYAML / presets.yaml。
- 只支持 clone 模式：参考音由调用方给绝对路径。
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

from indextts_engine import (  # noqa: E402
    create_index_tts2,
    load_config,
)
from job_runner import run_job  # noqa: E402
from progress import emit  # noqa: E402


def _log(msg: str) -> None:
    """所有人类可读日志走 stderr —— stdout 是 JSON 通道，混入会破坏解析。"""
    print(msg, file=sys.stderr, flush=True)


def _handle_job(tts, cfg: dict, job: dict) -> dict:
    # 具体执行体在 job_runner.run_job（与 HTTP 服务共用）。
    # run_index_tts_infer 内部已通过 emit() 输出 @@PROGRESS@@ 行（含 seg/audio），
    # 因此这里不再传 on_progress，避免重复上报。
    output = run_job(
        tts,
        cfg,
        text=job.get("text"),
        text_file=job.get("text_file"),
        output=job["output"],
        reference=str(job.get("reference") or ""),
        speed=job.get("speed") or "balanced",
    )
    return {"ok": True, "raw_audio": str(output)}


def stdio_loop(config_path: Path) -> int:
    emit(0.05, "config")
    cfg = load_config(config_path)
    emit(0.10, "indextts_load")
    _log("[indextts] loading model (first load may take 1-3 minutes)…")
    tts = create_index_tts2(cfg)
    emit(0.14, "indextts_ready")
    _log("[indextts] model ready")
    print(json.dumps({"ready": True, "backend": "indextts2-worker"}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == "ping":
            print(json.dumps({"pong": True}), flush=True)
            continue
        if line == "shutdown":
            print(json.dumps({"shutdown": True}), flush=True)
            break
        try:
            job = json.loads(line)
            result = _handle_job(tts, cfg, job)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as exc:
            _log(f"[indextts] job failed: {exc}")
            print(
                json.dumps(
                    {"ok": False, "error": str(exc), "trace": traceback.format_exc()},
                    ensure_ascii=False,
                ),
                flush=True,
            )
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="IndexTTS2 warm worker (stdio JSON lines)")
    parser.add_argument("--config", required=True, help="JSON config written by the Node side")
    parser.add_argument("--stdio", action="store_true", help="Read jobs from stdin (default)")
    args = parser.parse_args()

    config_path = Path(args.config).resolve()
    if not config_path.is_file():
        print(json.dumps({"ready": False, "error": f"config not found: {config_path}"}), flush=True)
        raise SystemExit(1)

    try:
        raise SystemExit(stdio_loop(config_path))
    except SystemExit:
        raise
    except BaseException as exc:
        # 加载阶段失败也要把原因通过 stdio 回给 Node，否则 Node 只能干等到超时。
        _log(f"[indextts] fatal: {exc}")
        print(json.dumps({"ready": False, "error": str(exc)}), flush=True)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
