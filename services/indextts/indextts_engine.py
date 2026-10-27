"""IndexTTS2 load + zero-shot clone inference.

移植自 JY_IPAgent 的 `tts/indextts_core.py`，按服务端场景裁剪：

- 只保留 clone 模式（参考音由调用方给绝对路径），不再有 preset / dialect / english
  分支，因此不需要 presets.yaml，也不需要 `resolve_speak_emo_spk`。
- 配置由 Node 侧写入 JSON（见 `indextts.config.ts`），不再依赖 PyYAML / config.yaml，
  也不再自动 pip install 任何东西。
- 不再生成 dubbing_timing 清单（那是视频/字幕管线的产物，本服务不做）。

与 IndexTTS2 内部直接对接的部分（`prepare_indextts_cfg` / `create_index_tts2` /
`run_index_tts_infer`）尽量与上游保持 1:1，便于日后跟版本。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Callable

from progress import emit, estimate_speech_seconds

ProgressFn = Callable[[float, str], None]


def load_config(config_path: Path | str) -> dict:
    """读 Node 侧生成的 JSON 配置。"""
    return json.loads(Path(config_path).read_text(encoding="utf-8"))


def resolve_install_dir(cfg: dict) -> Path:
    raw = (cfg.get("paths") or {}).get("indextts_dir") or ""
    if not raw:
        raise FileNotFoundError("配置缺少 paths.indextts_dir（IndexTTS2 安装目录）")
    return Path(raw).expanduser()


def model_paths(cfg: dict) -> tuple[Path, Path]:
    """返回 (模型 config.yaml, checkpoints 目录)。"""
    it_cfg = cfg.get("indextts", {}) or {}
    install = resolve_install_dir(cfg)
    model_dir = install / it_cfg.get("model_dir", "checkpoints")
    cfg_path = model_dir / "config.yaml"
    if not cfg_path.exists():
        raise FileNotFoundError(
            f"IndexTTS2 模型未找到: {model_dir}\n"
            "请确认 INDEXTTS_INSTALL_DIR 指向完整的 IndexTTS2 检出目录，且 checkpoints 已下载完毕。"
        )
    return cfg_path, model_dir


# --------------------------------------------------------------------------
# 权重完整性检查
# --------------------------------------------------------------------------

# 部分下载的安装常常缺这几个核心文件。
_CORE_CHECKPOINT_FILES: tuple[tuple[str, int], ...] = (
    ("gpt.pth", 100_000_000),
    ("s2mel.pth", 50_000_000),
    ("bpe.model", 1000),
    ("feat1.pt", 1000),
    ("feat2.pt", 1000),
    ("wav2vec2bert_stats.pt", 1000),
)


def missing_core_checkpoints(model_dir: Path) -> list[str]:
    missing: list[str] = []
    for name, min_size in _CORE_CHECKPOINT_FILES:
        p = model_dir / name
        if not p.is_file() or p.stat().st_size < min_size:
            missing.append(name)
    return missing


def core_checkpoints_ready(model_dir: Path) -> bool:
    return not missing_core_checkpoints(model_dir)


def _qwen_emo_dir(model_dir: Path) -> Path:
    return (model_dir / "qwen0.6bemo4-merge").resolve()


def _hf_weight_ready(dir_path: Path, *, min_bytes: int = 1_000_000) -> bool:
    """transformers 模型目录里是否有真实权重文件（而非只有 config）。"""
    if not dir_path.is_dir():
        return False
    for name in ("model.safetensors", "pytorch_model.bin", "model.safetensors.index.json"):
        p = dir_path / name
        if not p.is_file():
            continue
        if name.endswith(".json"):
            if any(dir_path.glob("*.safetensors")):
                return True
            continue
        if p.stat().st_size >= min_bytes:
            return True
    for p in dir_path.glob("*.safetensors"):
        if p.stat().st_size >= min_bytes:
            return True
    for p in dir_path.glob("pytorch_model*.bin"):
        if p.stat().st_size >= min_bytes:
            return True
    return False


def missing_hf_cache_aux(model_dir: Path) -> list[str]:
    """checkpoints/hf_cache 下的辅助模型（IndexTTS2 加载时必需）。"""
    cache = model_dir / "hf_cache"
    missing: list[str] = []
    if not _hf_weight_ready(cache / "w2v-bert-2.0", min_bytes=50_000_000):
        missing.append("hf_cache/w2v-bert-2.0（语音特征，约 1GB+；空壳目录会导致合成失败）")
    sc = cache / "semantic_codec_model.safetensors"
    if not sc.is_file() or sc.stat().st_size < 1_000_000:
        missing.append("hf_cache/semantic_codec_model.safetensors")
    camp = cache / "campplus_cn_common.bin"
    if not camp.is_file() or camp.stat().st_size < 10_000:
        missing.append("hf_cache/campplus_cn_common.bin")
    big = cache / "bigvgan"
    if not (big / "config.json").is_file() or not (big / "bigvgan_generator.pt").is_file():
        missing.append("hf_cache/bigvgan（vocoder）")
    return missing


def hf_cache_aux_ready(model_dir: Path) -> bool:
    return not missing_hf_cache_aux(model_dir)


def qwen_emo_ready(model_dir: Path) -> bool:
    """情感模型是否就绪。clone 试听默认不启用情感文本，因此该模型不会被加载，
    但仍作为「安装是否完整」的判据暴露给 /engine/status。"""
    emo = _qwen_emo_dir(model_dir)
    cfg_ok = (emo / "config.json").is_file()
    weight_ok = False
    for name in ("model.safetensors", "pytorch_model.bin", "model.safetensors.index.json"):
        p = emo / name
        if p.is_file() and (name.endswith(".json") or p.stat().st_size > 100_000_000):
            weight_ok = True
            break
    if not weight_ok:
        for p in emo.glob("*.safetensors"):
            if p.stat().st_size > 100_000_000:
                weight_ok = True
                break
    return cfg_ok and weight_ok


def readiness_report(cfg: dict) -> dict:
    """缺失清单，供 /engine/status 与报错信息使用。"""
    _, model_dir = model_paths(cfg)
    return {
        "model_dir": str(model_dir),
        "missing_core": missing_core_checkpoints(model_dir),
        "missing_aux": missing_hf_cache_aux(model_dir),
        "qwen_emo_ready": qwen_emo_ready(model_dir),
    }


def _assert_ready(model_dir: Path) -> None:
    missing = missing_core_checkpoints(model_dir)
    aux = missing_hf_cache_aux(model_dir)
    if not missing and not aux:
        return
    lines = []
    if missing:
        lines.append("核心权重: " + ", ".join(missing))
    if aux:
        lines.append("辅助模型: " + ", ".join(aux))
    raise FileNotFoundError(
        "IndexTTS2 权重不完整：\n  " + "\n  ".join(lines) + f"\n目录: {model_dir}\n"
        "请先补全权重（可设 INDEXTTS_ALLOW_DOWNLOAD=true 由本 worker 自动下载，或手动同步 checkpoints）。"
    )


def _hf_mirror_env() -> None:
    import os

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HUGGINGFACE_HUB_ENDPOINT", "https://hf-mirror.com")


# --------------------------------------------------------------------------
# 权重下载（仅在 INDEXTTS_ALLOW_DOWNLOAD=true 时可达）
# --------------------------------------------------------------------------


def _snapshot_indextts(model_dir: Path, patterns: list[str] | None = None) -> None:
    """Download IndexTTS-2 files into model_dir (ModelScope then HF mirror)."""
    _hf_mirror_env()
    last_err = ""
    try:
        from modelscope import snapshot_download

        kwargs: dict = {"local_dir": str(model_dir)}
        if patterns:
            kwargs["allow_patterns"] = patterns
        snapshot_download("IndexTeam/IndexTTS-2", **kwargs)
        return
    except Exception as exc:
        last_err = f"modelscope: {exc}"
    try:
        from huggingface_hub import snapshot_download as hf_snap

        kwargs = {
            "repo_id": "IndexTeam/IndexTTS-2",
            "local_dir": str(model_dir),
            "local_dir_use_symlinks": False,
        }
        if patterns:
            kwargs["allow_patterns"] = patterns
        hf_snap(**kwargs)
        return
    except Exception as exc:
        raise RuntimeError(f"IndexTTS 权重下载失败（{last_err}; hf: {exc}）") from exc


def ensure_core_checkpoints(model_dir: Path) -> None:
    """补齐 gpt.pth / s2mel.pth 等核心文件（仅下载开关打开时调用）。"""
    missing = missing_core_checkpoints(model_dir)
    if not missing:
        return
    model_dir.mkdir(parents=True, exist_ok=True)
    # 缺得多就整仓拉，缺得少只拉缺口。
    patterns = None if len(missing) >= 3 else list(missing)
    try:
        _snapshot_indextts(model_dir, patterns)
    except Exception:
        # 可能不支持按 pattern 下载 —— 退回全量
        if patterns is not None:
            _snapshot_indextts(model_dir, None)
        else:
            raise
    still = missing_core_checkpoints(model_dir)
    if still:
        raise FileNotFoundError(
            f"IndexTTS2 核心权重缺失: {', '.join(still)}\n目录: {model_dir}\n"
            "常见缺 gpt.pth（主模型，体积很大）。"
        )


def _download_w2v_bert(w2v_dir: Path) -> None:
    """Download facebook/w2v-bert-2.0 into flat hf_cache/w2v-bert-2.0."""
    import shutil

    _hf_mirror_env()
    if w2v_dir.exists():
        shutil.rmtree(w2v_dir, ignore_errors=True)
    w2v_dir.mkdir(parents=True, exist_ok=True)
    last_err = ""
    try:
        from modelscope import snapshot_download

        snapshot_download("AI-ModelScope/w2v-bert-2.0", local_dir=str(w2v_dir))
        if _hf_weight_ready(w2v_dir, min_bytes=50_000_000):
            return
        last_err = "modelscope: downloaded but weights missing"
    except Exception as exc:
        last_err = f"modelscope: {exc}"
    try:
        from huggingface_hub import snapshot_download as hf_snap

        hf_snap("facebook/w2v-bert-2.0", local_dir=str(w2v_dir), local_dir_use_symlinks=False)
    except Exception as exc:
        raise RuntimeError(
            f"下载 w2v-bert-2.0 失败（{last_err}; hf: {exc}）\n目标: {w2v_dir}"
        ) from exc
    if not _hf_weight_ready(w2v_dir, min_bytes=50_000_000):
        raise FileNotFoundError(
            f"w2v-bert-2.0 下载后仍缺权重文件: {w2v_dir}\n需要 model.safetensors 或 pytorch_model.bin。"
        )


def _download_hf_file(repo_id: str, filename: str, dest: Path) -> None:
    """Download one HF file (hub SDK → hf-mirror HTTP)."""
    import shutil
    import urllib.request

    _hf_mirror_env()
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_size > 1000:
        return
    try:
        from huggingface_hub import hf_hub_download

        path = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            local_dir=str(dest.parent),
            local_dir_use_symlinks=False,
        )
        p = Path(path)
        nested = dest.parent / filename
        if nested.is_file() and nested.resolve() != dest.resolve():
            shutil.copy2(nested, dest)
        elif p.is_file() and p.resolve() != dest.resolve():
            shutil.copy2(p, dest)
        if dest.is_file() and dest.stat().st_size > 1000:
            return
    except Exception:
        pass
    url = f"https://hf-mirror.com/{repo_id}/resolve/main/{filename}"
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=600) as resp, open(tmp, "wb") as out:
        shutil.copyfileobj(resp, out)
    tmp.replace(dest)
    if not dest.is_file() or dest.stat().st_size < 1000:
        raise RuntimeError(f"下载失败: {repo_id}/{filename}")


def _download_hf_cache_standalone(model_dir: Path) -> None:
    """完整拉取 hf_cache 辅助模型（不依赖 indextts.utils.model_download 的旧镜像）。"""
    import shutil

    cache = model_dir / "hf_cache"
    cache.mkdir(parents=True, exist_ok=True)
    w2v = cache / "w2v-bert-2.0"
    if not _hf_weight_ready(w2v, min_bytes=50_000_000):
        _download_w2v_bert(w2v)

    sc = cache / "semantic_codec_model.safetensors"
    if not sc.is_file() or sc.stat().st_size < 1_000_000:
        nested = cache / "semantic_codec" / "model.safetensors"
        try:
            _download_hf_file("amphion/MaskGCT", "semantic_codec/model.safetensors", nested)
            if nested.is_file():
                shutil.copy2(nested, sc)
        except Exception:
            _download_hf_file("amphion/MaskGCT", "semantic_codec/model.safetensors", sc)

    camp = cache / "campplus_cn_common.bin"
    if not camp.is_file() or camp.stat().st_size < 10_000:
        try:
            from modelscope.hub.file_download import model_file_download

            p = model_file_download(
                model_id="iic/speech_campplus_sv_zh-cn_16k-common",
                file_path="campplus_cn_common.bin",
                local_dir=str(cache),
            )
            if p and Path(p).is_file() and Path(p).resolve() != camp.resolve():
                shutil.copy2(p, camp)
        except Exception:
            pass
        if not camp.is_file() or camp.stat().st_size < 10_000:
            _download_hf_file("funasr/campplus", "campplus_cn_common.bin", camp)

    big = cache / "bigvgan"
    big.mkdir(parents=True, exist_ok=True)
    for name in ("config.json", "bigvgan_generator.pt"):
        dest = big / name
        if dest.is_file() and dest.stat().st_size > 100:
            continue
        _download_hf_file("nvidia/bigvgan_v2_22khz_80band_256x", name, dest)


def ensure_hf_cache_aux(model_dir: Path) -> None:
    """确保 checkpoints/hf_cache 辅助模型完整（仅下载开关打开时调用）。"""
    import shutil

    _hf_mirror_env()
    cache = model_dir / "hf_cache"
    cache.mkdir(parents=True, exist_ok=True)
    w2v = cache / "w2v-bert-2.0"
    if w2v.exists() and not _hf_weight_ready(w2v, min_bytes=50_000_000):
        shutil.rmtree(w2v, ignore_errors=True)

    try:
        from indextts.utils.model_download import ensure_models_available

        ensure_models_available(str(model_dir))
    except Exception:
        pass

    if missing_hf_cache_aux(model_dir):
        try:
            _download_hf_cache_standalone(model_dir)
        except Exception as exc:
            still = missing_hf_cache_aux(model_dir)
            raise FileNotFoundError(
                "IndexTTS2 辅助模型（hf_cache）不完整：\n"
                + "\n".join(f"· {m}" for m in still)
                + f"\n目录: {cache}\n详情: {exc}"
            ) from exc

    still = missing_hf_cache_aux(model_dir)
    if still:
        raise FileNotFoundError(
            "IndexTTS2 辅助模型（hf_cache）不完整：\n"
            + "\n".join(f"· {m}" for m in still)
            + f"\n目录: {cache}"
        )


def ensure_qwen_emo_model(model_dir: Path) -> Path:
    """确保 qwen0.6bemo4-merge 存在（仅下载开关打开时调用）。"""
    emo = _qwen_emo_dir(model_dir)
    if qwen_emo_ready(model_dir):
        return emo
    model_dir.mkdir(parents=True, exist_ok=True)
    last_err = ""
    try:
        _snapshot_indextts(model_dir, ["qwen0.6bemo4-merge/*", "qwen0.6bemo4-merge/**"])
    except Exception as exc:
        last_err = str(exc)
    if not qwen_emo_ready(model_dir):
        raise FileNotFoundError(
            f"IndexTTS2 情感模型缺失或不完整: {emo}\n详情: {last_err or '未找到 config.json / 权重文件'}"
        )
    return emo


# --------------------------------------------------------------------------
# 加载
# --------------------------------------------------------------------------


def prepare_indextts_cfg(
    cfg: dict,
    cfg_path: Path,
    model_dir: Path,
    out_dir: Path | None = None,
) -> Path:
    """按需补权重 + 生成运行期 config（把 qwen_emo_path 写成绝对 POSIX 路径）。

    `out_dir` 是 `config.agent.yaml` 的落点，缺省仍写 model_dir（与历史行为一致）。
    容器化部署下 checkpoints 以**只读**方式挂载，写 model_dir 会 EROFS，此时由调用方
    传入可写的运行期目录。
    """
    if bool((cfg.get("indextts") or {}).get("allow_download", False)):
        ensure_core_checkpoints(model_dir)
        ensure_hf_cache_aux(model_dir)
        emo = ensure_qwen_emo_model(model_dir)
    else:
        _assert_ready(model_dir)
        emo = _qwen_emo_dir(model_dir)

    # 落点先算好：只读挂载下写 model_dir 会抛 EROFS，不该落进下面的兜底分支再试一次
    target_dir = out_dir if out_dir is not None else model_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    out = target_dir / "config.agent.yaml"

    try:
        from omegaconf import OmegaConf

        oc = OmegaConf.load(str(cfg_path))
        oc.qwen_emo_path = emo.as_posix()
        OmegaConf.save(oc, str(out))
        return out
    except Exception:
        # 兜底：纯文本替换（部分环境没有 OmegaConf）
        raw = cfg_path.read_text(encoding="utf-8")
        line = 'qwen_emo_path: "{}"'.format(emo.as_posix())
        if re.search(r"(?m)^qwen_emo_path\s*:", raw):
            raw = re.sub(r"(?m)^qwen_emo_path\s*:.*$", line, raw)
        else:
            raw = raw.rstrip() + "\n" + line + "\n"
        out.write_text(raw, encoding="utf-8")
        return out


def ensure_indextts_importable(cfg: dict) -> Path:
    """把 IndexTTS 安装根放进 sys.path（官方文档要求 PYTHONPATH=.）。"""
    import sys

    install = resolve_install_dir(cfg)
    try:
        install_s = str(install.resolve())
    except OSError:
        install_s = str(install)
    if install_s not in sys.path:
        sys.path.insert(0, install_s)

    try:
        import indextts  # noqa: F401
    except ImportError as exc:
        pkg = install / "indextts" / "infer_v2.py"
        raise ModuleNotFoundError(
            "IndexTTS2 包不可用（No module named 'indextts'）。\n"
            f"安装目录: {install}\n"
            f"源码 infer_v2: {'有' if pkg.is_file() else '无'}\n"
            "请确认 INDEXTTS_INSTALL_DIR 指向完整检出目录且已 uv sync 安装依赖。\n"
            f"详情: {exc}"
        ) from exc
    return install


def create_index_tts2(cfg: dict, out_dir: Path | None = None):
    """加载模型。`out_dir` 透传给 prepare_indextts_cfg（只读权重挂载时必传）。"""
    ensure_indextts_importable(cfg)
    from indextts.infer_v2 import IndexTTS2

    it_cfg = cfg.get("indextts", {}) or {}
    cfg_path, model_dir = model_paths(cfg)
    patched = prepare_indextts_cfg(cfg, cfg_path, model_dir, out_dir=out_dir)
    aux_paths = None
    try:
        from indextts.utils.model_download import ensure_models_available

        aux_paths = ensure_models_available(str(model_dir.resolve()))
    except Exception:
        aux_paths = None
    kwargs = dict(
        cfg_path=str(patched.resolve()),
        model_dir=str(model_dir.resolve()),
        use_fp16=bool(it_cfg.get("use_fp16", True)),
        use_cuda_kernel=bool(it_cfg.get("use_cuda_kernel", False)),
        use_deepspeed=False,
    )
    if aux_paths is not None:
        kwargs["aux_paths"] = aux_paths
    try:
        return IndexTTS2(**kwargs)
    except TypeError:
        # 旧版 IndexTTS 没有 aux_paths 参数
        kwargs.pop("aux_paths", None)
        return IndexTTS2(**kwargs)


# --------------------------------------------------------------------------
# 推理
# --------------------------------------------------------------------------

# 对齐 JY_IPAgent 的 tts/speed.py（只保留 indextts 部分）。
SPEED_PRESETS: dict[str, dict] = {
    "fast": {"temperature": 0.75, "top_p": 0.75, "top_k": 25, "max_text_tokens_per_segment": 80},
    "balanced": {"temperature": 0.8, "top_p": 0.8, "top_k": 30, "max_text_tokens_per_segment": 72},
    "quality": {"temperature": 0.85, "top_p": 0.85, "top_k": 35, "max_text_tokens_per_segment": 140},
}


def get_speed_preset(name: str) -> dict:
    return SPEED_PRESETS.get(name or "balanced", SPEED_PRESETS["balanced"])


def _wav_duration_sec(path: Path) -> float:
    import wave

    with wave.open(str(path), "rb") as wf:
        rate = wf.getframerate() or 1
        return wf.getnframes() / float(rate)


def _resolve_max_mel_tokens(cfg: dict) -> int:
    """优先用配置里的显式值；否则读模型自带 config.yaml（需要 PyYAML）。

    PyYAML 缺失且未显式配置时返回 IndexTTS2 的默认值，不抛错、更不自动安装依赖。
    """
    it_cfg = cfg.get("indextts", {}) or {}
    if it_cfg.get("max_mel_tokens"):
        return int(it_cfg["max_mel_tokens"])
    try:
        import yaml  # noqa: PLC0415

        cfg_path, _ = model_paths(cfg)
        model_cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        return int((model_cfg.get("gpt") or {}).get("max_mel_tokens", 1815))
    except Exception:
        return 1815


def _synthesis_complete(
    *,
    out: Path,
    est_audio: float,
    expected_segments: int,
    has_emo: bool = False,
) -> bool:
    if not out.is_file() or out.stat().st_size < 1000:
        return False
    actual = _wav_duration_sec(out)
    # clone + 情感描述时语速常偏快、预估时长偏长，放宽阈值避免误报截断
    threshold = 0.68 if has_emo else 0.76
    if est_audio > 0 and actual < est_audio * threshold:
        return False
    del expected_segments  # 保留形参以对齐上游签名；本服务不产出 timing 分段
    return True


def _retry_segment_tokens(base: int, attempt: int) -> int:
    """逐次缩小分段，避免 max_mel_tokens 截断。"""
    if attempt <= 0:
        return base
    factors = (0.75, 0.58, 0.5, 0.42)
    factor = factors[min(attempt - 1, len(factors) - 1)]
    return max(48, int(base * factor))


def run_index_tts_infer(
    tts,
    cfg: dict,
    *,
    speak_text: str,
    output_path: Path | str,
    spk_wav: str,
    speed: str = "balanced",
    on_progress: ProgressFn | None = None,
) -> Path:
    """零样本克隆合成：参考音只看 spk_wav，不叠加情感文本。"""
    it_cfg = cfg.get("indextts", {}) or {}
    speed_cfg = get_speed_preset(speed)
    est_audio = estimate_speech_seconds(speak_text)
    out = Path(output_path)

    def gr_progress(value: float, desc: str = "") -> None:
        seg_cur, seg_total = 0, 0
        m = re.search(r"(\d+)/(\d+)", desc or "")
        if m:
            seg_cur, seg_total = int(m.group(1)), int(m.group(2))
        inner = max(0.0, min(1.0, (float(value) - 0.1) / 0.8))
        pct = 0.22 + 0.75 * inner
        if seg_total > 0 and seg_cur > 0:
            seg: tuple[int, int] | None = (seg_cur, seg_total)
            audio_sec: float | None = est_audio * seg_cur / seg_total
        else:
            seg, audio_sec = None, est_audio * inner
        if on_progress:
            on_progress(pct, "indextts_synth")
        emit(pct, "indextts_synth", seg=seg, audio_sec=audio_sec)

    tts.gr_progress = gr_progress

    infer_kwargs = {
        "spk_audio_prompt": str(Path(spk_wav).resolve()),
        "text": speak_text,
        "output_path": str(out.resolve()),
        "verbose": True,
        "max_text_tokens_per_segment": int(
            speed_cfg.get("max_text_tokens_per_segment", it_cfg.get("max_text_tokens_per_segment", 120))
        ),
        "max_mel_tokens": _resolve_max_mel_tokens(cfg),
        "interval_silence": int(it_cfg.get("interval_silence", 200)),
        "use_emo_text": False,
        "temperature": min(
            float(speed_cfg.get("temperature", it_cfg.get("temperature", 0.8))),
            float(it_cfg.get("clone_temperature", 0.75)),
        ),
        "top_p": float(speed_cfg.get("top_p", it_cfg.get("top_p", 0.8))),
        "top_k": int(speed_cfg.get("top_k", it_cfg.get("top_k", 30))),
    }

    if on_progress:
        on_progress(0.22, "indextts_synth")
    emit(0.22, "indextts_synth", audio_sec=0.0)

    text_tokens_list = tts.tokenizer.tokenize(speak_text)
    base_seg_tokens = int(infer_kwargs["max_text_tokens_per_segment"])
    max_attempts = 4

    for attempt in range(max_attempts):
        attempt_kwargs = dict(infer_kwargs)
        if attempt > 0:
            if out.is_file():
                out.unlink(missing_ok=True)
            attempt_kwargs["max_text_tokens_per_segment"] = _retry_segment_tokens(base_seg_tokens, attempt)
            pct = 0.22 + 0.02 * attempt
            if on_progress:
                on_progress(pct, "indextts_synth")
            emit(pct, "indextts_synth")

        expected_segments = len(
            tts.tokenizer.split_segments(text_tokens_list, int(attempt_kwargs["max_text_tokens_per_segment"]))
        )
        tts.infer(**attempt_kwargs)
        infer_kwargs = attempt_kwargs

        if _synthesis_complete(out=out, est_audio=est_audio, expected_segments=expected_segments):
            break
    else:
        actual = _wav_duration_sec(out) if out.is_file() else 0.0
        # 短句试听：有可用音频且时长合理就放行
        if not (out.is_file() and actual >= 2.0 and (est_audio <= 0 or actual >= est_audio * 0.62)):
            seg_hint = int(infer_kwargs.get("max_text_tokens_per_segment", base_seg_tokens))
            raise RuntimeError(
                f"配音不完整：实际约 {actual:.0f} 秒，预估约 {est_audio:.0f} 秒。"
                f"可能在长句或中英混排处被截断。可降低 indextts.max_text_tokens_per_segment"
                f"（当前约 {seg_hint}）或提高 max_mel_tokens"
                f"（当前 {int(infer_kwargs.get('max_mel_tokens', 1815))}）。"
            )

    emit(1.0, "indextts_done", audio_sec=est_audio)
    if on_progress:
        on_progress(1.0, "indextts_done")
    return out.resolve()
