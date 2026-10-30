"""Beat + downbeat tracking (Beat This!, with a librosa fallback)."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from audio_utils import load


def track(mix_wav: Path, device: str):
    y, sr = load(mix_wav)
    try:
        from beat_this.inference import Audio2Beats
        a2b = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)
        beats, downbeats = a2b(y.astype(np.float64), sr)
        del a2b
        return np.asarray(beats, float), np.asarray(downbeats, float), "beat_this"
    except Exception as exc:  # noqa: BLE001
        if device != "cpu" and not isinstance(exc, ImportError):
            raise  # let the pipeline retry on CPU first
        print("[beats] Beat This! failed, falling back to librosa:", exc)
        import librosa
        mono = y.mean(axis=1)
        _, beats = librosa.beat.beat_track(y=mono, sr=sr, units="time")
        beats = np.asarray(beats, float)
        return beats, beats[::4], "librosa"
