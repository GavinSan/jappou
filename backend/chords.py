"""Chord recognition from the separated harmonic stems (guitar + piano + bass + other).

Plain numpy/scipy (no extra dependencies):
  1. chroma (12 pitch classes) per beat from a log-frequency spectrum
  2. match against chord templates (maj, min, 7, maj7, m7, sus4, dim)
  3. Viterbi smoothing so chords only change when the music really changes,
     preferably on strong beats
  4. bass note from the bass stem -> slash chords (C/E, Am/G ...)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

NOTE = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
MAJOR_SCALE = (0, 2, 4, 5, 7, 9, 11)
FLAT_KEYS = {5, 10, 3, 8, 1, 6}   # F Bb Eb Ab Db Gb major (and their relative minors)
# intervals, display suffix, prior (small penalty for rarer / easily over-detected types)
TYPES = [
    ("maj", (0, 4, 7), "", 0.0),
    ("min", (0, 3, 7), "m", 0.0),
    ("7", (0, 4, 7, 10), "7", -0.035),
    ("maj7", (0, 4, 7, 11), "maj7", -0.04),
    ("m7", (0, 3, 7, 10), "m7", -0.035),
    ("sus4", (0, 5, 7), "sus4", -0.06),
    ("dim", (0, 3, 6), "dim", -0.08),
]
SR = 11025


def _mono_resample(y: np.ndarray, sr: int) -> np.ndarray:
    if y.ndim == 2:
        y = y.mean(axis=1)
    if sr != SR:
        from math import gcd
        g = gcd(int(sr), SR)
        y = resample_poly(y, SR // g, int(sr) // g)
    return y.astype(np.float32)


def _spectrogram(y: np.ndarray, n_fft: int, hop: int):
    n = 1 + max(0, (len(y) - n_fft) // hop)
    if n <= 0:
        return np.zeros((1, n_fft // 2 + 1), np.float32)
    win = np.hanning(n_fft).astype(np.float32)
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n)[:, None]
    frames = y[idx] * win
    return np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)


def _chroma(y: np.ndarray, fmin: float, fmax: float, n_fft: int, hop: int):
    """Returns (chroma [frames, 12], frame_times)."""
    S = _spectrogram(y, n_fft, hop)
    S = np.log1p(100.0 * S / (S.max() + 1e-9))      # compress dynamics
    freqs = np.fft.rfftfreq(n_fft, 1 / SR)
    sel = (freqs >= fmin) & (freqs <= fmax)
    f = freqs[sel]
    midi = 69 + 12 * np.log2(f / 440.0)
    near = np.round(midi)
    keep = np.abs(midi - near) < 0.4                  # ignore bins between semitones
    pc = (near.astype(int) % 12)[keep]
    Ssel = S[:, sel][:, keep]
    C = np.zeros((S.shape[0], 12), np.float32)
    for k in range(12):
        m = pc == k
        if m.any():
            C[:, k] = Ssel[:, m].sum(axis=1)
    times = (np.arange(S.shape[0]) * hop + n_fft / 2) / SR
    return C, times


def _beat_sync(C: np.ndarray, times: np.ndarray, edges: np.ndarray) -> np.ndarray:
    out = np.zeros((len(edges) - 1, 12), np.float32)
    idx = np.searchsorted(times, edges)
    for i in range(len(edges) - 1):
        a, b = idx[i], max(idx[i] + 1, idx[i + 1])
        seg = C[a:b]
        if len(seg):
            out[i] = np.median(seg, axis=0) * 0.5 + seg.mean(axis=0) * 0.5
    return out


def _templates():
    names, roots, kinds, T, prior = [], [], [], [], []
    for r in range(12):
        for kind, iv, suf, pr in TYPES:
            v = np.zeros(12, np.float32)
            for j, i in enumerate(iv):
                v[(r + i) % 12] = 1.0 if j < 3 else 0.75
            v /= np.linalg.norm(v)
            names.append(NOTE[r] + suf)
            roots.append(r)
            kinds.append(kind)
            T.append(v)
            prior.append(pr)
    return names, np.array(roots), kinds, np.stack(T), np.array(prior, np.float32)


def recognize(harm: np.ndarray, bass: np.ndarray | None, sr: int, beats: list[dict], end_time: float,
              beats_per_bar: int = 4) -> list[dict]:
    """harm: mix of harmonic stems, bass: bass stem (or None). beats: timing.json 'beats'.
    Returns [{start, end, name, root, kind, bass}] (one entry per chord change)."""
    y = _mono_resample(harm, sr)
    C, t = _chroma(y, 65, 2100, 4096, 512)
    if bass is not None:
        yb = _mono_resample(bass, sr)
        B, tb = _chroma(yb, 38, 260, 8192, 512)
    else:
        B, tb = _chroma(y, 38, 160, 8192, 512)

    times = np.array([b["time"] for b in beats] + [end_time], dtype=np.float64)
    keep = times[:-1] > -0.01
    edges = np.concatenate([np.maximum(times[:-1][keep], 0), [end_time]])
    beat_pos = np.array([b["beat"] for b in beats])[keep]
    if len(edges) < 3:
        return []
    Cb = _beat_sync(C, t, edges)
    Bb = _beat_sync(B, tb, edges)
    energy = Cb.sum(axis=1)
    loud = np.percentile(energy, 90) + 1e-9
    Cn = Cb / (np.linalg.norm(Cb, axis=1, keepdims=True) + 1e-9)
    Bn = Bb / (Bb.sum(axis=1, keepdims=True) + 1e-9)

    names, roots, kinds, T, prior = _templates()
    em = Cn @ T.T + prior[None, :]                          # cosine similarity
    em += 0.18 * Bn[:, roots]                               # bass usually plays the root
    nochord = np.where(energy < 0.08 * loud, 1.0, 0.25)     # "N" state wins on silence
    em = np.concatenate([em, nochord[:, None]], axis=1)
    S = em.shape[1]

    # Viterbi: staying is free, changing costs more off the strong beats
    K = 12.0
    score = K * em[0].copy()
    back = np.zeros((len(em), S), np.int32)
    for i in range(1, len(em)):
        bp = beat_pos[i]
        if bp == 0:
            pen = 0.9
        elif beats_per_bar % 2 == 0 and bp == beats_per_bar // 2:
            pen = 1.4
        else:
            pen = 2.2
        best = int(np.argmax(score))
        stay = score
        change = score[best] - pen
        take_change = change > stay
        back[i] = np.where(take_change, best, np.arange(S))
        score = np.maximum(stay, change) + K * em[i]
    path = np.zeros(len(em), np.int32)
    path[-1] = int(np.argmax(score))
    for i in range(len(em) - 1, 0, -1):
        path[i - 1] = back[i, path[i]]

    # merge beats into segments, add slash bass
    out: list[dict] = []
    i = 0
    while i < len(path):
        j = i
        while j + 1 < len(path) and path[j + 1] == path[i]:
            j += 1
        s = int(path[i])
        if s < len(names):
            root, kind = int(roots[s]), kinds[s]
            bass_pc = None
            prof = Bn[i:j + 1].mean(axis=0)
            top = int(np.argmax(prof))
            if top != root and prof[top] > 0.42 and (j - i + 1) >= 2:
                bass_pc = top
            name = names[s] + (f"/{NOTE[bass_pc]}" if bass_pc is not None else "")
            out.append({"start": round(float(edges[i]), 3), "end": round(float(edges[j + 1]), 3),
                        "name": name, "root": root, "kind": kind,
                        "bass": bass_pc if bass_pc is not None else root})
        i = j + 1
    key = _key(out)
    out = _drop_blips(out, key, float(np.median(np.diff(edges))))
    names_for = FLATS if key in FLAT_KEYS else SHARPS
    suffix = {k: suf for k, _iv, suf, _p in TYPES}
    for c in out:
        c["name"] = names_for[c["root"]] + suffix[c["kind"]] + (f"/{names_for[c['bass']]}" if c["bass"] != c["root"] else "")
    return out


def _key(segs: list[dict]) -> int:
    """Major key (0-11) whose scale best covers the chord roots, weighted by duration."""
    w = np.zeros(12)
    for c in segs:
        w[c["root"]] += c["end"] - c["start"]
    best, best_s = 0, -1.0
    for k in range(12):
        sc = sum(w[(k + i) % 12] for i in MAJOR_SCALE) + 1.0 * w[k] + 0.2 * w[(k + 7) % 12]
        if sc > best_s:
            best, best_s = k, sc
    return best


def key_name(segs: list[dict]) -> str:
    k = _key(segs)
    return (FLATS if k in FLAT_KEYS else SHARPS)[k]


def _drop_blips(segs: list[dict], key: int, beat_len: float) -> list[dict]:
    """Remove one-beat chords outside the key: almost always detection noise."""
    scale = {(key + i) % 12 for i in MAJOR_SCALE}
    out = []
    for c in segs:
        short = c["end"] - c["start"] < 1.3 * beat_len
        if out and short and c["root"] not in scale:
            out[-1]["end"] = c["end"]
            continue
        if out and out[-1]["root"] == c["root"] and out[-1]["kind"] == c["kind"] and out[-1]["bass"] == c["bass"]:
            out[-1]["end"] = c["end"]
            continue
        out.append(c)
    return out


def run_for_job(folder: Path, stem_paths: dict, timing: dict, loader) -> list[dict]:
    """loader(path) -> (audio [samples, ch] float32, sr)."""
    harm, sr = None, None
    for name in ("guitar", "piano", "other", "bass"):
        p = stem_paths.get(name)
        if not p or not Path(p).exists():
            continue
        y, s = loader(p)
        y = y.mean(axis=1) if y.ndim == 2 else y
        w = 0.6 if name == "bass" else 1.0
        if harm is None:
            harm, sr = w * y, s
        else:
            n = min(len(harm), len(y))
            harm = harm[:n] + w * y[:n]
    if harm is None:
        return []
    bass = None
    if stem_paths.get("bass") and Path(stem_paths["bass"]).exists():
        bass, _ = loader(stem_paths["bass"])
    return recognize(harm, bass, sr, timing["beats"], timing["endTime"], timing.get("beatsPerBar", 4))
