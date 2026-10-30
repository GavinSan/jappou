"""Stem separation with Demucs (htdemucs_6s: drums, bass, other, vocals, guitar, piano)."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from audio_utils import load, save_wav, rms_db_frames

STEM_NAMES = ["drums", "bass", "other", "vocals", "guitar", "piano"]


def separate(wav_path: Path, out_dir: Path, device: str, progress=lambda p: None, model_name="htdemucs_6s"):
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model(model_name)
    model.eval()
    y, sr = load(wav_path)  # [samples, 2]
    if sr != model.samplerate:
        raise RuntimeError(f"expected {model.samplerate} Hz audio")
    wav = torch.from_numpy(y.T.copy())  # [2, samples]
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    # demucs reports progress through tqdm; we just tick before/after
    progress(0.05)
    with torch.no_grad():
        sources = apply_model(model, wav[None], device=device, shifts=1, split=True,
                              overlap=0.25, progress=False, num_workers=0)[0]
    sources = sources * std + mean
    progress(0.95)

    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, src in zip(model.sources, sources):
        p = out_dir / f"{name}.wav"
        save_wav(p, src.cpu().numpy().T, sr)
        paths[name] = p
    del model, sources, wav
    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()
    return paths


def detect_instruments(stem_paths: dict, mix_path: Path) -> dict:
    """Decide which instruments are really present by how often each stem is
    loud relative to the mix."""
    mix, sr = load(mix_path, mono=True)
    mix_db = rms_db_frames(mix, sr)
    ref = np.percentile(mix_db, 95)
    result = {}
    for name, p in stem_paths.items():
        y, sr = load(p, mono=True)
        db = rms_db_frames(y, sr)
        n = min(len(db), len(mix_db))
        active = (db[:n] > ref - 30).mean()          # frames within 30 dB of the loud parts
        level = float(np.percentile(db, 95) - ref)   # how loud the stem gets vs the mix
        thresh = 0.08 if name != "other" else 0.15
        present = bool(active > thresh and level > -24)
        result[name] = {"present": present, "activity": round(float(active), 3), "level": round(level, 1)}
    return result
