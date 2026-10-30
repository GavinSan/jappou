"""Audio IO helpers. Uses the ffmpeg binary bundled with imageio-ffmpeg so nothing
has to be installed system-wide."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = shutil.which("ffmpeg")
        if not exe:
            raise RuntimeError("搵唔到 ffmpeg（請重新執行 install.bat）")
        return exe


def _run(args):
    flags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        flags = subprocess.CREATE_NO_WINDOW
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg error: " + p.stderr.decode("utf-8", "ignore")[-800:])


def to_wav(src: Path, dst: Path, sr: int = 44100, channels: int = 2):
    _run([ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
          "-vn", "-ac", str(channels), "-ar", str(sr), "-c:a", "pcm_f32le", str(dst)])


def to_mp3(src: Path, dst: Path, kbps: int = 192):
    """Encode a wav file to mp3 (lameenc, which comes with demucs; ffmpeg as fallback)."""
    try:
        import lameenc
        y, sr = load(src)
        pcm = (np.clip(y, -1, 1) * 32767).astype("<i2")
        enc = lameenc.Encoder()
        enc.set_bit_rate(kbps)
        enc.set_in_sample_rate(sr)
        enc.set_channels(pcm.shape[1])
        enc.set_quality(2)
        data = enc.encode(pcm.tobytes()) + enc.flush()
        Path(dst).write_bytes(data)
    except ImportError:
        _run([ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
              "-c:a", "libmp3lame", "-b:a", f"{kbps}k", str(dst)])


def load(path: Path, mono: bool = False):
    """Returns (audio float32 [samples, channels] or [samples], sr)."""
    y, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if mono:
        y = y.mean(axis=1)
    return y, sr


def save_wav(path: Path, y: np.ndarray, sr: int):
    sf.write(str(path), y, sr, subtype="FLOAT")


def rms_db_frames(y: np.ndarray, sr: int, hop: float = 0.05):
    """Mono RMS in dB per frame."""
    if y.ndim == 2:
        y = y.mean(axis=1)
    h = max(1, int(sr * hop))
    n = len(y) // h
    if n == 0:
        return np.array([-120.0])
    frames = y[: n * h].reshape(n, h)
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
    return 20 * np.log10(rms + 1e-12)
