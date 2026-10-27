#!/usr/bin/env python3
"""PySceneDetect 场景切分：视频 → 场景时间段 JSON。

两种入口共用同一套检测核心 `detect_video()`：
  - CLI（宿主 venv 本地调试 / 旧的一次性子进程用法）：`python detect_scenes.py --input a.mp4 ...`
  - HTTP 服务（services/scenedetect/http/server.py，生产路径）：POST /api/v1/detect

用法：
    python detect_scenes.py --input a.mp4 [--detector content] [--threshold 27] \
        [--min-scene-len 0.6] [--downscale 2] [--frame-skip 0]

输出（stdout，UTF-8，单行 JSON）：
    {"ok": true, "version": "0.6.6", "detector": "content", "threshold": 27.0,
     "frameRate": 30.0, "durationMs": 125000, "sceneCount": 3,
     "scenes": [{"index": 1, "startMs": 0, "endMs": 12000, "durationMs": 12000}, ...]}

失败时同样输出 JSON（ok=false + error），并以退出码 2 结束，便于 Node 侧统一解析。
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from typing import Any, Dict, List, Optional, Tuple

# 检测器名 → 缺省阈值（沿用 PySceneDetect 各算法的推荐值，见官方文档）
DETECTORS = {
    "content": 27.0,
    "adaptive": 3.0,
    "threshold": 12.0,
}

# 缺省最短场景时长（秒）：与 CLI 的 --min-scene-len 缺省一致
DEFAULT_MIN_SCENE_LEN_SEC = 0.6


def _fail(message: str, *, detail: str = "") -> int:
    """统一失败出口：JSON 到 stdout，明细到 stderr，退出码 2。"""
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    if detail:
        print(detail, file=sys.stderr)
    return 2


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PySceneDetect 场景切分（输出 JSON）")
    parser.add_argument("--input", required=True, help="输入视频绝对路径")
    parser.add_argument(
        "--detector",
        default="content",
        choices=sorted(DETECTORS),
        help="检测算法：content 内容突变（默认）/ adaptive 自适应 / threshold 亮度阈值",
    )
    parser.add_argument("--threshold", type=float, default=None, help="检测阈值，缺省用该算法的推荐值")
    parser.add_argument(
        "--min-scene-len",
        type=float,
        default=DEFAULT_MIN_SCENE_LEN_SEC,
        help="最短场景时长（秒），默认 0.6",
    )
    parser.add_argument(
        "--downscale",
        type=int,
        default=None,
        help="检测前降采样倍数（1=不降采样）；缺省由 PySceneDetect 按分辨率自动选择",
    )
    parser.add_argument("--frame-skip", type=int, default=0, help="隔帧采样数（0=逐帧，越大越快越粗）")
    return parser.parse_args(argv)


def build_detector(name: str, threshold: float, min_scene_len_frames: int):
    """按名称构造检测器。0.6 推荐从 scenedetect.detectors 导入，更早版本只在顶层暴露，故两处都试。"""
    try:
        from scenedetect.detectors import AdaptiveDetector, ContentDetector, ThresholdDetector
    except ImportError:  # pragma: no cover - 兼容旧版本
        from scenedetect import AdaptiveDetector, ContentDetector, ThresholdDetector

    if name == "content":
        return ContentDetector(threshold=threshold, min_scene_len=min_scene_len_frames)
    if name == "adaptive":
        return AdaptiveDetector(adaptive_threshold=threshold, min_scene_len=min_scene_len_frames)
    return ThresholdDetector(threshold=threshold, min_scene_len=min_scene_len_frames)


def to_scenes(scene_list: List[Tuple[Any, Any]], duration_ms: int) -> List[Dict[str, int]]:
    """(FrameTimecode start, FrameTimecode end) 列表 → 毫秒区间列表（对外以 ms 为唯一时间单位）。"""
    scenes: List[Dict[str, int]] = []
    for start, end in scene_list:
        start_ms = max(0, int(round(start.get_seconds() * 1000)))
        end_ms = max(start_ms, int(round(end.get_seconds() * 1000)))
        scenes.append(
            {
                "index": len(scenes) + 1,
                "startMs": start_ms,
                "endMs": end_ms,
                "durationMs": end_ms - start_ms,
            }
        )

    if not scenes and duration_ms > 0:
        # 无切点：整段视频视为一个场景，保证调用方永远拿得到至少一段
        scenes.append({"index": 1, "startMs": 0, "endMs": duration_ms, "durationMs": duration_ms})
    return scenes


def detect_video(
    input_path: str,
    *,
    detector: str = "content",
    threshold: Optional[float] = None,
    min_scene_len_sec: Optional[float] = None,
    downscale: Optional[int] = None,
    frame_skip: Optional[int] = 0,
) -> Dict[str, Any]:
    """检测核心：读视频 → 算切点 → 返回与 CLI 完全一致的 payload（恒 ok=True）。

    失败一律抛异常（由 CLI 的 main / HTTP 服务各自包装成 ok=false 或 HTTP 错误）。
    未知 detector / 视频不可读分别抛 ValueError / FileNotFoundError。
    """
    if detector not in DETECTORS:
        raise ValueError(f"未知检测算法：{detector}")

    from scenedetect import SceneManager, open_video

    min_len = DEFAULT_MIN_SCENE_LEN_SEC if min_scene_len_sec is None else min_scene_len_sec

    video = open_video(input_path)
    frame_rate = float(video.frame_rate)
    duration_ms = int(round(video.duration.get_seconds() * 1000))

    effective_threshold = DETECTORS[detector] if threshold is None else threshold
    # min_scene_len 的语义是「帧数」（0.6 的签名即为 int），秒 → 帧，至少 1 帧
    min_frames = max(1, int(round(max(0.0, min_len) * frame_rate)))

    manager = SceneManager()
    # 0.6 起 downscale 挂在 SceneManager 上；显式给了倍数就关掉自动选择，否则保持自适应
    if downscale is not None:
        manager.auto_downscale = False
        manager.downscale = downscale
    manager.add_detector(build_detector(detector, effective_threshold, min_frames))

    manager.detect_scenes(video, frame_skip=max(0, frame_skip or 0), show_progress=False)
    # start_in_scene=True：把首个切点之前的那一段也算作场景，使结果覆盖整段视频
    scene_list = manager.get_scene_list(start_in_scene=True)
    # sceneCount 与 scenes 同源：无切点时也会补齐为整段单一场景，二者必须一致
    scenes = to_scenes(scene_list, duration_ms)

    return {
        "ok": True,
        "version": _version(),
        "detector": detector,
        "threshold": float(effective_threshold),
        "minSceneLenSec": float(min_len),
        "frameRate": frame_rate,
        "durationMs": duration_ms,
        "sceneCount": len(scenes),
        "scenes": scenes,
    }


def _version() -> str:
    try:
        import scenedetect

        version = getattr(scenedetect, "__version__", None)
        if version:
            return str(version)
    except Exception:  # noqa: BLE001 - 版本号只是元信息，取不到不影响结果
        pass
    try:
        from importlib.metadata import version as pkg_version

        return pkg_version("scenedetect")
    except Exception:  # noqa: BLE001
        return "unknown"


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    try:
        result = detect_video(
            args.input,
            detector=args.detector,
            threshold=args.threshold,
            min_scene_len_sec=args.min_scene_len,
            downscale=args.downscale,
            frame_skip=args.frame_skip,
        )
    except ModuleNotFoundError as err:
        return _fail(
            f"缺少依赖：{err.name}。请安装 PySceneDetect"
            "（pip install -r services/scenedetect/requirements.txt）",
            detail=traceback.format_exc(),
        )
    except FileNotFoundError as err:
        return _fail(f"视频文件不可读：{err}", detail=traceback.format_exc())
    except Exception as err:  # noqa: BLE001 - 兜底：任何异常都以 JSON 形式回给调用方
        return _fail(f"场景检测失败：{err}", detail=traceback.format_exc())

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
