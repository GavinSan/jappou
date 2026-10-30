"""Drum transcription: ADTOF (5 classes) + simple refinements
(tom pitch -> high/mid/floor tom, hi-hat open/closed, crash vs ride)."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from audio_utils import load

# ADTOF classes -> General MIDI drum notes
KICK, SNARE, TOM, HH, CYM = 35, 38, 47, 42, 49
GM = {"kick": 36, "snare": 38, "hh_closed": 42, "hh_open": 46, "crash": 49, "ride": 51,
      "tom_high": 50, "tom_mid": 47, "tom_floor": 43}


def transcribe_drums(drum_wav: Path, device: str, sensitivity: float = 1.0):
    """Returns list of {time, note, vel} using GM note numbers."""
    import torch
    from adtof_pytorch import (calculate_n_bins, create_frame_rnn_model, load_audio_for_model,
                               load_pytorch_weights, get_default_weights_path, PeakPicker,
                               FRAME_RNN_THRESHOLDS, LABELS_5)

    model = create_frame_rnn_model(calculate_n_bins())
    model.eval()
    w = get_default_weights_path()
    if w:
        model = load_pytorch_weights(model, w, strict=False)
    model.to(device)
    x = load_audio_for_model(str(drum_wav)).to(device)
    with torch.no_grad():
        act = model(x).cpu().numpy()  # [1, frames, 5]
    del model
    thresholds = [min(0.9, t / max(0.3, sensitivity)) for t in FRAME_RNN_THRESHOLDS]
    peaks = PeakPicker(thresholds=thresholds, fps=100).pick(act, labels=LABELS_5, label_offset=0)[0]

    y, sr = load(drum_wav, mono=True)
    events = []
    for label, times in peaks.items():
        for t in np.asarray(times, dtype=float).reshape(-1):
            fi = min(int(t * 100), act.shape[1] - 1)
            strength = float(act[0, fi, LABELS_5.index(int(label))])
            vel = int(np.clip(50 + strength * 90, 40, 127))
            events.append({"time": float(t), "label": int(label), "vel": vel})
    events.sort(key=lambda e: e["time"])
    return refine(events, y, sr)


def _band_energy(y, sr, t, dur, lo, hi):
    a = int(t * sr)
    b = min(len(y), a + int(dur * sr))
    seg = y[a:b]
    if len(seg) < 64:
        return 0.0
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    m = (freqs >= lo) & (freqs < hi)
    return float((spec[m] ** 2).sum())


def _centroid(y, sr, t, dur=0.08, lo=40, hi=600):
    a = int(t * sr)
    seg = y[a: a + int(dur * sr)]
    if len(seg) < 64:
        return 0.0
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    m = (freqs >= lo) & (freqs < hi)
    if spec[m].sum() <= 0:
        return 0.0
    return float((freqs[m] * spec[m]).sum() / spec[m].sum())


def refine(events, y, sr):
    out = []
    # --- toms: split by pitch into up to 3 groups ---------------------------
    toms = [e for e in events if e["label"] == TOM]
    if toms:
        cents = np.array([_centroid(y, sr, e["time"]) for e in toms])
        if len(toms) >= 6 and cents.std() > 15:
            q1, q2 = np.percentile(cents, [33, 66])
            for e, c in zip(toms, cents):
                e["note"] = GM["tom_floor"] if c <= q1 else GM["tom_high"] if c > q2 else GM["tom_mid"]
        elif len(toms) >= 2 and cents.std() > 15:
            med = np.median(cents)
            for e, c in zip(toms, cents):
                e["note"] = GM["tom_high"] if c > med else GM["tom_floor"]
        else:
            for e in toms:
                e["note"] = GM["tom_mid"]

    # --- hi-hat: open if the high band keeps ringing ------------------------
    hh = [e for e in events if e["label"] == HH]
    hh_times = np.array([e["time"] for e in hh])
    for i, e in enumerate(hh):
        nxt = hh_times[i + 1] if i + 1 < len(hh_times) else e["time"] + 1
        gap = nxt - e["time"]
        if gap < 0.18:
            e["note"] = GM["hh_closed"]
            continue
        early = _band_energy(y, sr, e["time"], 0.04, 6000, 16000)
        late = _band_energy(y, sr, e["time"] + 0.12, 0.06, 6000, 16000)
        e["note"] = GM["hh_open"] if early > 0 and late / early > 0.25 else GM["hh_closed"]

    # --- cymbals: regular streams of cymbal hits are ride -------------------
    cy = [e for e in events if e["label"] == CYM]
    ct = np.array([e["time"] for e in cy])
    for i, e in enumerate(cy):
        near = ct[(ct > e["time"] - 1.2) & (ct < e["time"] + 1.2)]
        e["note"] = GM["ride"] if len(near) >= 4 else GM["crash"]

    for e in events:
        if e["label"] == KICK:
            e["note"] = GM["kick"]
        elif e["label"] == SNARE:
            e["note"] = GM["snare"]
        out.append({"time": round(e["time"], 4), "note": int(e["note"]), "vel": e["vel"]})
    return out
