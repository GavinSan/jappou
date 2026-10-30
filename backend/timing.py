"""Beat grid helpers: turn detected beats/downbeats into a regular bar grid.

Everything here is pure numpy so it can be unit-tested without the ML stack.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

import numpy as np


@dataclass
class Grid:
    beats: np.ndarray            # beat start times (s), len = n_bars * beats_per_bar + 1 (last = end of last bar)
    beats_per_bar: int
    bpm: float
    n_bars: int
    first_detected_beat: int = 0  # index in `beats` of the first beat the tracker actually found
    subdiv: np.ndarray = field(default=None)  # per-beat subdivision (4 = 16ths, 3 = 8th triplets)

    @property
    def n_beats(self) -> int:
        return self.n_bars * self.beats_per_bar

    def to_json(self) -> dict:
        n = self.beats_per_bar
        return {
            "beatsPerBar": n,
            "bpm": round(float(self.bpm), 2),
            "nBars": self.n_bars,
            # one entry per beat: bar index, beat-in-bar, time in seconds (can be negative for the pickup)
            "beats": [
                {"bar": i // n, "beat": i % n, "time": round(float(t), 4)}
                for i, t in enumerate(self.beats[: self.n_beats])
            ],
            "endTime": round(float(self.beats[self.n_beats]), 4),
        }


def _mode(values, default):
    values = [v for v in values]
    if not values:
        return default
    return Counter(values).most_common(1)[0][0]


def build_grid(beats, downbeats, duration: float, meter: int | None = None,
               shift: int = 0, tempo_factor: float = 1.0) -> Grid:
    """meter: force beats per bar; shift: move bar lines by N beats;
    tempo_factor: 2 = double-time (insert half beats), 0.5 = half-time."""
    beats = np.unique(np.asarray(beats, dtype=float))
    downbeats = np.asarray(downbeats, dtype=float)

    if len(beats) < 4:
        # Nothing usable -> plain 120 bpm 4/4 grid
        beats = np.arange(0.0, max(duration, 2.0), 0.5)
        downbeats = beats[::4]

    if tempo_factor == 2:
        mids = (beats[:-1] + beats[1:]) / 2
        beats = np.sort(np.concatenate([beats, mids]))
    elif tempo_factor == 0.5:
        # keep the beats that line up with downbeats
        best = 0
        if len(downbeats):
            hits = [sum(np.min(np.abs(beats[o::2][:, None] - downbeats[None, :]), axis=0) < 0.07) for o in (0, 1)]
            best = int(np.argmax(hits))
        beats = beats[best::2]

    ibi = np.diff(beats)
    med = float(np.median(ibi)) if len(ibi) else 0.5
    med = min(max(med, 0.25), 1.5)

    # --- meter: how many beats between downbeats --------------------------
    down_idx = []
    for d in downbeats:
        k = int(np.argmin(np.abs(beats - d)))
        if abs(beats[k] - d) < 0.1:
            down_idx.append(k)
    down_idx = sorted(set(down_idx))
    gaps = [b - a for a, b in zip(down_idx, down_idx[1:]) if 2 <= b - a <= 7]
    n = int(meter) if meter else int(_mode(gaps, 4))
    phase = (int(_mode([k % n for k in down_idx], 0)) + int(shift)) % n

    # --- extend backwards so the grid starts at or before t=0 on a downbeat --
    pre = []
    t = beats[0]
    while t > 0:
        t -= med
        pre.append(t)
    p = len(pre)
    while (phase + p) % n != 0:
        t -= med
        pre.append(t)
        p += 1
    ext = np.concatenate([np.array(pre[::-1]), beats])
    first_detected = p

    # --- extend forwards to cover the whole song and complete the last bar ---
    post = []
    t = ext[-1]
    while t < duration:
        t += med
        post.append(t)
    ext = np.concatenate([ext, np.array(post)])
    n_bars = int(np.ceil((len(ext) - 1) / n))
    need = n_bars * n + 1 - len(ext)
    t = ext[-1]
    extra = []
    for _ in range(max(0, need)):
        t += med
        extra.append(t)
    ext = np.concatenate([ext, np.array(extra)])

    # Drop trailing bars that start after the song ends
    while n_bars > 1 and ext[(n_bars - 1) * n] >= duration:
        n_bars -= 1
    ext = ext[: n_bars * n + 1]

    bpm = 60.0 / med
    return Grid(beats=ext, beats_per_bar=n, bpm=bpm, n_bars=n_bars,
                first_detected_beat=first_detected,
                subdiv=np.full(n_bars * n, 4, dtype=int))


# --- quantisation -----------------------------------------------------------

def locate(grid: Grid, t: float):
    """Return (beat index k, fractional position 0..1 inside beat k)."""
    b = grid.beats
    k = int(np.searchsorted(b, t, side="right") - 1)
    k = min(max(k, 0), grid.n_beats - 1)
    span = b[k + 1] - b[k]
    frac = (t - b[k]) / span if span > 0 else 0.0
    return k, float(min(max(frac, 0.0), 0.9999))


def choose_subdivisions(grid: Grid, onset_times, allow_triplets: bool = True) -> np.ndarray:
    """Per beat, pick 16th (4) or 8th-triplet (3) subdivision based on the onsets."""
    per_beat: dict[int, list[float]] = {}
    for t in onset_times:
        k, f = locate(grid, t)
        per_beat.setdefault(k, []).append(f)
    sub = np.full(grid.n_beats, 4, dtype=int)
    if not allow_triplets:
        return sub
    for k, fr in per_beat.items():
        fr = np.array(fr)
        if len(fr) < 2:
            continue
        err4 = np.abs(fr * 4 - np.round(fr * 4)).mean() / 4
        err3 = np.abs(fr * 3 - np.round(fr * 3)).mean() / 3
        # a triplet needs onsets that clearly sit on 1/3 or 2/3 of the beat
        on_trip = np.any(np.abs(fr - 1 / 3) < 0.06) or np.any(np.abs(fr - 2 / 3) < 0.06)
        if on_trip and err3 < err4 * 0.5 and err4 > 0.03:
            sub[k] = 3
    # smooth: isolated triplet beats surrounded by 16ths are usually noise
    for k in range(1, len(sub) - 1):
        if sub[k] == 3 and sub[k - 1] == 4 and sub[k + 1] == 4:
            fr = np.array(per_beat.get(k, []))
            if len(fr) < 3:
                sub[k] = 4
    return sub


def quantize(grid: Grid, t: float):
    """Snap time t to (beat k, slot j) using the grid's per-beat subdivision.

    Returns a position as a tuple (k, j) where j < subdiv[k]."""
    k, f = locate(grid, t)
    m = int(grid.subdiv[k])
    j = int(round(f * m))
    if j >= m:
        if k + 1 < grid.n_beats:
            return k + 1, 0
        return k, m - 1
    return k, j


def pos_value(grid: Grid, k: int, j: int) -> float:
    return k + j / grid.subdiv[k]
