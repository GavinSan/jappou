"""Play the transcribed drums back with a real (sampled) drum kit.

Every hit in drums.json becomes a clean, standard drum sound, so you hear exactly
what is written in the chart, without the noise and bleed of the separated drum
track. Samples: Virtuosity Drums (CC0), see assets/drumkit/README.md.
"""
from __future__ import annotations

import tempfile
import shutil
from functools import lru_cache
from pathlib import Path

import numpy as np

import audio_utils as au

KIT = Path(__file__).parent / "assets" / "drumkit"
SR = 44100
KIT_VERSION = 2

# GM note (+ how it is played) -> sample name
PIECE = {
    36: "kick", 35: "kick",
    38: "snare", 40: "rim", 37: "xstick",
    42: "hhc", 44: "hhp", 46: "hho",
    49: "crash", 52: "crash", 55: "crash", 57: "crash2",
    51: "ride", 59: "ride", 53: "bell",
    50: "tom1", 48: "tom1", 47: "tom2", 45: "tom2", 43: "floor", 41: "floor",
}
HIHATS = {"hhc", "hhp", "hho"}
GAIN = {"kick": 1.0, "snare": 0.9, "rim": 0.9, "xstick": 0.8, "hhc": 0.55, "hhp": 0.5, "hho": 0.55,
        "crash": 0.6, "crash2": 0.6, "ride": 0.5, "bell": 0.5, "tom1": 0.85, "tom2": 0.85, "floor": 0.9}


@lru_cache(maxsize=None)
def _layers(name: str):
    files = sorted(KIT.glob(f"{name}_v*.flac"), key=lambda p: int(p.stem.rsplit("_v", 1)[1]))
    out = []
    for p in files:
        y, sr = au.load_any(p)
        if y.ndim == 1:
            y = np.stack([y, y], axis=1)
        if sr != SR:
            raise RuntimeError(f"{p.name}: expected {SR} Hz")
        out.append(y.astype(np.float32))
    return out


def available() -> bool:
    return (KIT / "kick_v1.flac").exists()


def _pick(name: str, vel: int, art: str | None):
    layers = _layers(name)
    if not layers:
        return None, 0.0
    v = max(1, min(127, int(vel)))
    if art == "ghost":
        v = min(v, 45)
    elif art == "accent":
        v = max(v, 118)
    x = v / 127.0
    k = min(len(layers) - 1, int(x * len(layers)))
    gain = GAIN.get(name, 0.8) * (0.35 + 0.65 * x)
    return layers[k], gain


def render(drums: list[dict], duration: float) -> np.ndarray:
    n = int((duration + 3.0) * SR)
    out = np.zeros((n, 2), np.float32)
    events = sorted(drums, key=lambda d: d["time"])
    hh_buf = np.zeros((n, 2), np.float32)    # open hi-hats, so they can be choked
    open_hh: list[tuple[int, int]] = []      # (start, end) of ringing open hi-hats
    for d in events:
        name = PIECE.get(int(d.get("note", 0)))
        if not name:
            continue
        art = d.get("art")
        if name == "snare" and art == "rim":
            name = "rim"
        a = int(round(float(d["time"]) * SR))
        if a >= n:
            continue
        if name in HIHATS and open_hh:
            # the next hi-hat closes it: cut the ring of the open one (it lives in its own buffer)
            s0, e0 = open_hh.pop()
            if s0 < a < e0:
                f = min(int(0.03 * SR), e0 - a)
                hh_buf[a:a + f] *= np.linspace(1, 0, f)[:, None]
                hh_buf[a + f:e0] = 0
        if art in ("flam", "drag"):
            for i in range(2 if art == "drag" else 1):
                g_s, g_g = _pick(name, 40, None)
                if g_s is not None:
                    ga = max(0, a - int((0.025 if art == "drag" else 0.03) * SR) * (i + 1))
                    m = min(len(g_s), n - ga)
                    out[ga:ga + m] += g_s[:m] * g_g * 0.5
        s, g = _pick(name, d.get("vel", 100), art)
        if s is None:
            continue
        m = min(len(s), n - a)
        if name == "hho":
            hh_buf[a:a + m] += s[:m] * g
            open_hh.append((a, a + m))
        else:
            out[a:a + m] += s[:m] * g
    out += hh_buf
    return out[: int(duration * SR) + SR]


def _rms(y: np.ndarray) -> float:
    """Loudness of the busy parts (ignores silence)."""
    m = y.mean(axis=1) if y.ndim == 2 else y
    win = SR // 10
    n = len(m) // win
    if n < 1:
        return float(np.sqrt(np.mean(m ** 2)) + 1e-9)
    e = np.sqrt((m[: n * win].reshape(n, win) ** 2).mean(axis=1))
    e = e[e > e.max() * 0.05] if e.max() > 0 else e
    return float(np.sqrt(np.mean(e ** 2)) + 1e-9)


def finish(y: np.ndarray, match: np.ndarray | None = None) -> np.ndarray:
    """As loud as the separated drum track (a little louder: it is cleaner),
    with a soft limiter instead of turning everything down for one loud crash."""
    target = _rms(match) * 1.25 if match is not None and len(match) else 0.18
    target = min(max(target, 0.08), 0.3)
    y = y * (target / _rms(y))
    knee = 0.8
    a = np.abs(y)
    over = a > knee
    y[over] = np.sign(y[over]) * (knee + (1 - knee) * np.tanh((a[over] - knee) / (1 - knee)))
    return y.astype(np.float32)


def render_job(folder: Path, drums: list[dict], duration: float) -> Path | None:
    """Write stems/drums_std.mp3. Returns the path, or None without samples."""
    if not available() or not drums:
        return None
    y = render(drums, duration)
    ref = None
    orig = folder / "stems" / "drums.mp3"
    if orig.exists():
        try:
            ref, _ = au.load_any(orig)
        except Exception:  # noqa: BLE001
            ref = None
    y = finish(y, ref)
    stems = folder / "stems"
    stems.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="jappou_kit_"))
    try:
        wav = tmp / "drums_std.wav"
        au.save_wav(wav, y, SR)
        au.to_mp3(wav, stems / "drums_std.mp3")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return stems / "drums_std.mp3"
