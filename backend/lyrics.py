"""Lyrics transcription with OpenAI Whisper on the vocal stem (word timestamps)."""
from __future__ import annotations

import os
import platform
import re
import sys
from pathlib import Path
import warnings

# whisper falls back to slower CPU kernels when Triton isn't available (normal on Windows)
warnings.filterwarnings("ignore", message="Failed to launch Triton kernels")

LANG_PROMPTS = {
    "yue": "以下係廣東話歌詞。",
    "zh": "以下是普通話歌詞。",
    "ja": "以下は日本語の歌詞です。",
    "ko": "다음은 한국어 노래 가사입니다.",
    "en": "Song lyrics:",
}

HALLUCINATIONS = [
    "字幕", "訂閱", "订阅", "點贊", "点赞", "Amara", "感謝觀看", "感谢观看", "ご視聴", "시청해 주셔서",
    "Thank you for watching", "Subtitles by",
]


def _is_apple_silicon() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


def _ram_gb() -> float:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024 ** 3
    except (ValueError, OSError, AttributeError):
        return 8.0


def pick_model_name(requested: str | None = None) -> str:
    if requested and requested != "auto":
        return requested
    if _is_apple_silicon():
        return "large-v3" if _ram_gb() >= 15 else "turbo"
    try:
        import torch
        if torch.cuda.is_available():
            vram = torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
            if vram >= 10.5:
                return "large-v3"
            if vram >= 5.5:
                return "turbo"
            return "small"
    except Exception:
        pass
    return "small"


MLX_REPOS = {
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "medium": "mlx-community/whisper-medium-mlx",
    "small": "mlx-community/whisper-small-mlx",
}


def transcribe(vocal_wav: Path, language: str = "auto", model_name: str | None = None, device: str = "cuda"):
    # load + resample ourselves: whisper's own loader needs ffmpeg on PATH
    import librosa
    audio, _ = librosa.load(str(vocal_wav), sr=16000, mono=True)
    audio = audio.astype("float32")

    name = pick_model_name(model_name)
    lang = None if language in (None, "", "auto") else language
    if lang == "yue" and not name.startswith(("large-v3", "turbo")):
        lang = "zh"  # older models don't know Cantonese as a separate language
    opts = dict(
        language=lang,
        word_timestamps=True,
        condition_on_previous_text=False,
        temperature=(0.0, 0.2, 0.4),
        no_speech_threshold=0.6,
        logprob_threshold=-1.0,
        initial_prompt=LANG_PROMPTS.get(lang or "", None),
        verbose=None,
    )

    result = None
    if _is_apple_silicon():
        # Apple Silicon: MLX build of Whisper runs on the Mac GPU and is much faster
        try:
            import mlx_whisper
            result = mlx_whisper.transcribe(audio, path_or_hf_repo=MLX_REPOS.get(name, MLX_REPOS["turbo"]), **opts)
            name = "mlx-" + name
        except ImportError:
            pass
    if result is None:
        import torch
        import whisper
        dev = "cuda" if device == "cuda" else "cpu"  # openai-whisper is unreliable on Apple MPS
        model = whisper.load_model(name, device=dev)
        result = model.transcribe(audio, task="transcribe", fp16=(dev == "cuda"), **opts)
        del model
        if dev == "cuda":
            torch.cuda.empty_cache()
    detected = result.get("language", lang or "")

    conv = _converter(detected)
    lines = []
    for seg in result.get("segments", []):
        if seg.get("no_speech_prob", 0) > 0.7 and seg.get("avg_logprob", 0) < -0.8:
            continue
        text = seg.get("text", "").strip()
        if not text or any(h in text for h in HALLUCINATIONS):
            continue
        words = [{"start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3),
                  "word": conv(w["word"])} for w in seg.get("words", []) if w.get("word", "").strip()]
        for line_words in _split_words(words):
            if not line_words:
                continue
            lines.append({
                "start": line_words[0]["start"],
                "end": line_words[-1]["end"],
                "text": _join(line_words, detected),
                "words": line_words,
            })
    if not lines:
        # nothing usable from word timing -> plain segments
        for seg in result.get("segments", []):
            t = seg.get("text", "").strip()
            if t and not any(h in t for h in HALLUCINATIONS):
                lines.append({"start": round(seg["start"], 3), "end": round(seg["end"], 3),
                              "text": conv(t), "words": []})
    return {"language": detected, "model": name, "lines": lines}


def _converter(lang: str):
    if lang not in ("zh", "yue"):
        return lambda s: s
    try:
        from opencc import OpenCC
        cc = OpenCC("s2hk")
        return cc.convert
    except Exception:
        return lambda s: s


def _split_words(words, gap=0.7, max_chars=28):
    """Break a whisper segment into singable lines at pauses / punctuation."""
    lines, cur, chars = [], [], 0
    for i, w in enumerate(words):
        if cur and (w["start"] - cur[-1]["end"] > gap or chars > max_chars):
            lines.append(cur)
            cur, chars = [], 0
        cur.append(w)
        chars += len(w["word"].strip())
        if re.search(r"[。！？!?，,、]$", w["word"].strip()) and chars > 6:
            lines.append(cur)
            cur, chars = [], 0
    if cur:
        lines.append(cur)
    return lines


def _join(words, lang):
    if lang in ("zh", "yue", "ja"):
        s = "".join(w["word"].strip() for w in words)
    else:
        s = "".join(w["word"] for w in words).strip()
    return re.sub(r"[，,。]$", "", s)
