"""宿主机侧的冒烟脚本：不起容器、不经 HTTP，直接跑一次图片理解。

用途与 `services/whisper/run_whisper.py` 相同：**打镜像前先验通**「venv 装得对不对、
权重下不下来的、4bit 装不装得进显存」。这一步过了再 `docker compose up`，
能省掉一轮「容器起不来但看不出是哪一层错」的排查。

    engine/.venv/bin/python run_vlm.py --image /tmp/demo.jpg --mode json

首次运行会从 hf-mirror 拉权重（4bit 量化后约 3GB）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from vlm_engine import load_model, parse_json_object, readiness_report, understand

#: 冒烟用的 JSON 指令。**正式链路由 Node 侧下发**（utils/constant/vlm.ts 的 VLM_DEFAULT_PROMPT），
#: 这里只是让脚本能脱离 Node 独立跑通一次。
SMOKE_JSON_PROMPT = (
    "你是画面分析助手。请只输出一个 JSON 对象，不要输出任何解释文字、不要用 markdown 代码块。\n"
    "字段要求：\n"
    "- description: 一句话概括画面内容（中文，不超过 40 字）\n"
    "- objects: 画面中主要物体或人物名称数组（中文，最多 8 个）\n"
    '- actions: 正在发生的动作数组（中文，最多 5 个）\n'
    '- sceneType: 只能是 indoor / outdoor / other 之一\n'
    "- tags: 便于检索的主题标签数组（中文，最多 5 个）\n"
    "无法判断时给出空数组或 \"other\"，不要编造。"
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Qwen3-VL 图片理解冒烟脚本")
    parser.add_argument("--image", required=True, help="图片绝对/相对路径")
    parser.add_argument("--prompt", default="", help="自定义指令；留空按 --mode 取默认")
    parser.add_argument("--mode", default="json", choices=["json", "text"], help="输出形态")
    parser.add_argument(
        "--model",
        default="Qwen/Qwen3-VL-4B-Instruct",
        help="模型 id；可换 unsloth/Qwen3-VL-4B-Instruct-bnb-4bit（预量化，冷启动更快）",
    )
    parser.add_argument("--device", default="cuda", help="cuda / cpu")
    parser.add_argument("--attn", default="sdpa", help="sdpa / flash_attention_2")
    parser.add_argument("--no-4bit", action="store_true", help="关闭 NF4 量化（bf16，显存约翻三倍）")
    parser.add_argument("--models-dir", default="./engine/models", help="权重缓存目录")
    parser.add_argument("--max-new-tokens", type=int, default=256)
    parser.add_argument("--min-pixels", type=int, default=56 * 56)
    parser.add_argument("--max-pixels", type=int, default=1280 * 28 * 28)
    args = parser.parse_args()

    image_path = Path(args.image).expanduser()
    if not image_path.is_file():
        print(f"图片不存在：{image_path}", file=sys.stderr)
        return 2

    models_dir = Path(args.models_dir).expanduser().resolve()
    cfg = {
        "model": args.model,
        "device": args.device,
        "attn": args.attn,
        # CPU 上不做 4bit（与 settings.engine_config 同口径）
        "load_in_4bit": (not args.no_4bit) and args.device.startswith("cuda"),
        "min_pixels": args.min_pixels,
        "max_pixels": args.max_pixels,
        "max_new_tokens": args.max_new_tokens,
        "models_dir": models_dir,
        "allow_download": True,
    }

    print(f"权重状态：{json.dumps(readiness_report(cfg), ensure_ascii=False)}", file=sys.stderr)

    def on_progress(pct: float, stage: str) -> None:
        print(f"  [{pct:.2f}] {stage}", file=sys.stderr, flush=True)

    prompt = args.prompt.strip() or (SMOKE_JSON_PROMPT if args.mode == "json" else "用中文简要描述这张图片的内容。")

    engine = load_model(cfg, on_progress)
    print(f"加载完成（{engine['load_ms']}ms）", file=sys.stderr)

    outcome = understand(
        engine,
        image_path,
        prompt,
        max_new_tokens=args.max_new_tokens,
        on_progress=on_progress,
    )

    parsed = outcome["json"]
    if args.mode == "json" and parsed is None:
        print("原始输出无法解析为 JSON：", file=sys.stderr)
        print(outcome["text"], file=sys.stderr)
        return 2

    print(json.dumps({"text": outcome["text"], "json": parsed, "elapsed_ms": outcome["elapsed_ms"]},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
