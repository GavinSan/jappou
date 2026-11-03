"""Drum transcription: ADTOF (5 classes) + simple refinements
(tom pitch -> high/mid/floor tom, hi-hat open/closed, crash vs ride)."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from audio_utils import load

# ADTOF classes -> General MIDI drum notes
KICK, SNARE, TOM, HH, CYM = 35, 38, 47, 42, 49
GM = {"kick": 36, "snare": 38, "hh_closed": 42, "hh_open": 46, "crash": 49, "crash2": 57, "ride": 51,
      "tom_high": 50, "tom_mid": 47, "tom_floor": 43}


def transcribe_drums(drum_wav: Path, device: str, sensitivity: float = 1.0):
    """Returns list of {time, note, vel[, art][, how]} using GM note numbers."""
    import torch
    from adtof_pytorch import (calculate_n_bins, create_frame_rnn_model, load_audio_for_model,
                               load_pytorch_weights, get_default_weights_path)

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
    y2, sr = load(drum_wav, mono=False)
    return postprocess(act[0], y2, sr, sensitivity)


def postprocess(act: np.ndarray, y2: np.ndarray, sr: int, sensitivity: float = 1.0):
    """act: [frames, 5] ADTOF activations at 100 fps; y2: drum stem [samples, ch]."""
    from adtof_pytorch import PeakPicker, FRAME_RNN_THRESHOLDS, LABELS_5
    thresholds = [min(0.9, t / max(0.3, sensitivity)) for t in FRAME_RNN_THRESHOLDS]
    peaks = PeakPicker(thresholds=thresholds, fps=FPS).pick(act[None], labels=LABELS_5, label_offset=0)[0]
    if y2.ndim == 1:
        y2 = y2[:, None]
    y = y2.mean(axis=1)
    env = Envelopes(y2, sr)
    ci = LABELS_5.index(CYM)
    peaks[CYM] = sorted(set(np.round(np.asarray(peaks.get(CYM, []), dtype=float), 2)) |
                        set(_extra_cymbals(act[:, ci], peaks.get(CYM, []), env, sensitivity)))
    events = []
    for label, times in peaks.items():
        for t in np.asarray(times, dtype=float).reshape(-1):
            fi = min(int(round(t * FPS)), act.shape[0] - 1)
            strength = float(act[max(0, fi - 1): fi + 2, LABELS_5.index(int(label))].max())
            vel = int(np.clip(50 + strength * 90, 40, 127))
            events.append({"time": float(t), "label": int(label), "vel": vel, "s": strength})
    events.sort(key=lambda e: e["time"])
    return refine(events, y, sr, env)


FPS = 100


class Envelopes:
    """Band energies of the drum stem at 100 frames / s (mono, left, right)."""
    BANDS = {"hi": (5000, 15000), "mid": (1500, 5000), "snare": (150, 2500)}

    def __init__(self, y2: np.ndarray, sr: int):
        hop = sr // FPS
        n_fft = 1024
        win = np.hanning(n_fft).astype(np.float32)
        freqs = np.fft.rfftfreq(n_fft, 1 / sr)
        masks = {k: (freqs >= lo) & (freqs < hi) for k, (lo, hi) in self.BANDS.items()}
        n = max(1, 1 + len(y2) // hop)
        chans = {"m": y2.mean(axis=1)}
        if y2.shape[1] >= 2:
            chans["L"], chans["R"] = y2[:, 0], y2[:, 1]
        self.e = {}
        for cname, sig in chans.items():
            sig = np.pad(sig.astype(np.float32), (n_fft // 2, n_fft))   # frame k is centred on k / FPS
            out = {k: np.zeros(n, np.float32) for k in masks if cname == "m" or k == "hi"}
            for a in range(0, n, 2000):   # in chunks: low memory use
                b = min(n, a + 2000)
                idx = (np.arange(a, b) * hop)[:, None] + np.arange(n_fft)[None, :]
                spec = np.abs(np.fft.rfft(sig[idx] * win, axis=1)) ** 2
                for k in out:
                    out[k][a:b] = spec[:, masks[k]].sum(axis=1)
            for k, v in out.items():
                self.e[(cname, k)] = v
        self.n = n
        hi = self.e[("m", "hi")]
        d = np.maximum(0, np.log1p(hi[1:] * 1e3) - np.log1p(hi[:-1] * 1e3))
        self.hiflux = np.concatenate([[0], d])
        med = np.median(self.hiflux)
        mad = np.median(np.abs(self.hiflux - med)) + 1e-6
        self.hiflux_z = (self.hiflux - med) / (1.4826 * mad)

    def get(self, band, ch="m"):
        return self.e.get((ch, band))

    def onset(self, band, fi, ch="m"):
        """Energy jump at frame fi: peak just after minus level just before."""
        x = self.get(band, ch)
        if x is None or fi >= self.n:
            return 0.0
        pre = x[max(0, fi - 6): max(1, fi - 1)]
        post = x[fi: fi + 5]
        if not len(post):
            return 0.0
        return float(max(0.0, post.max() - (pre.mean() if len(pre) else 0.0)))


def _extra_cymbals(c: np.ndarray, found, env: Envelopes, sensitivity: float):
    """ADTOF's peak picker subtracts the average of the last 100 ms, so cymbal hits
    played close together (the wash never dies down) or softly are often lost.
    Look again with a gentler test, and keep a hit only if the audio really has a
    fresh burst of high frequencies there."""
    found = np.asarray(found, dtype=float)
    low = 0.14 / max(0.3, sensitivity)
    out = []
    for i in range(3, len(c) - 2):
        v = c[i]
        if v < low or v < c[i - 2: i + 3].max():
            continue
        if v - c[max(0, i - 8): i - 1].min() < 0.07:      # must rise, not just stay high
            continue
        t = i / FPS
        if len(found) and np.abs(found - t).min() < 0.06:
            continue
        if out and t - out[-1] < 0.06:
            continue
        z = env.hiflux_z[max(0, i - 2): i + 3]
        if len(z) and z.max() > 3.0:
            out.append(round(t, 2))
    return out


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


def refine(events, y, sr, env: Envelopes | None = None):
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

    # --- cymbals: crash or ride, and which crash ----------------------------
    cy = [e for e in events if e["label"] == CYM]
    classify_cymbals(cy, env)
    if env is not None:
        assign_crashes([e for e in cy if e["note"] == GM["crash"]], hh, events, env)

    # --- snare ghost notes: much softer than the usual snare ----------------
    sn = [e for e in events if e["label"] == SNARE]
    if env is not None and len(sn) >= 8:
        en = np.array([env.onset("snare", int(round(e["time"] * FPS))) for e in sn])
        med = np.median(en)
        for e, v in zip(sn, en):
            if med > 0 and v < 0.15 * med and e.get("s", 1) < 0.5:
                e["art"] = "ghost"
                e["vel"] = min(e["vel"], 60)

    for e in events:
        if e["label"] == KICK:
            e["note"] = GM["kick"]
        elif e["label"] == SNARE:
            e["note"] = GM["snare"]
        d = {"time": round(e["time"], 4), "note": int(e["note"]), "vel": e["vel"]}
        for k in ("art", "how"):
            if e.get(k):
                d[k] = e[k]
        out.append(d)
    return out


def _two_means(x: np.ndarray, iters: int = 30):
    """Tiny k-means with k=2 on rows of x. Returns (labels, centres)."""
    x = np.asarray(x, dtype=float)
    if x.ndim == 1:
        x = x[:, None]
    s = x.sum(axis=1)
    c = np.stack([x[s <= np.percentile(s, 30)].mean(axis=0), x[s >= np.percentile(s, 70)].mean(axis=0)])
    lab = np.zeros(len(x), int)
    for _ in range(iters):
        d = ((x[:, None, :] - c[None]) ** 2).sum(axis=2)
        new = d.argmin(axis=1)
        if (new == lab).all() and _:
            break
        lab = new
        for k in (0, 1):
            if (lab == k).any():
                c[k] = x[lab == k].mean(axis=0)
    return lab, c


def _cym_features(e, env: Envelopes, next_t: float | None = None):
    """(brightness, ring) of the sound this hit ADDS (whatever was already ringing
    is taken off), so a ride under a ringing crash still sounds like a ride.
    ring = how much of the new burst is left 0.10-0.18 s later (log ratio):
    a crash keeps ringing, a ride's ping dies away quickly."""
    fi = int(round(e["time"] * FPS))
    if fi + 5 > env.n or fi < 2:
        return None
    hi, mid = env.get("hi"), env.get("mid")
    pre_h = hi[max(0, fi - 6): fi - 1].mean()
    pre_m = mid[max(0, fi - 6): fi - 1].mean()
    hj = max(0.0, hi[fi: fi + 5].max() - pre_h)
    mj = max(0.0, mid[fi: fi + 5].max() - pre_m)
    if hj <= 0:
        return None
    bright = float(np.log((hj + 1e-9) / (mj + 1e-9 + 1e-3 * hj)))
    if next_t is not None and next_t - e["time"] < 0.19:
        return bright, None
    tail = hi[min(env.n - 1, fi + 10): min(env.n, fi + 18)]
    left = (tail.mean() if len(tail) else 0.0) - pre_h
    ring = float(max(-6.0, np.log(max(left, 1e-9) / hj)))
    return bright, ring


RING_CRASH = -1.0   # rings at least this much (log energy ratio) -> sounds like a crash


def classify_cymbals(cy, env: Envelopes | None):
    """Crash vs ride.
    * If the song's cymbal hits fall into two clearly different sounds (one rings,
      one dies away), go by sound - that keeps fast or soft crash hits as crashes.
    * Otherwise a steady stream of hits is a ride - unless the stream itself keeps
      ringing like a crash (crash "riding"), or one hit is far louder than the
      others around it (a crash on top of the ride)."""
    if not cy:
        return
    times = np.array([e["time"] for e in cy])
    feats = None
    if env is not None:
        feats = [_cym_features(e, env, times[i + 1] if i + 1 < len(times) else None) for i, e in enumerate(cy)]
    if feats and len(cy) >= 12:
        full = [i for i, f in enumerate(feats) if f is not None and f[1] is not None]
        if len(full) >= 12:
            f = np.array([feats[i] for i in full])
            z = (f - f.mean(axis=0)) / (f.std(axis=0) + 1e-9)
            lab, _c = _two_means(z)
            raw = [f[lab == k].mean(axis=0) for k in (0, 1)]
            crash_k = int(np.argmax([r[1] for r in raw]))
            share = (lab != crash_k).mean()
            gap = raw[crash_k][1] - raw[1 - crash_k][1]
            if 0.1 <= share <= 0.9 and gap > 1.2 and raw[1 - crash_k][1] < RING_CRASH:
                # assign every hit to the nearer sound (hits without a ring value by brightness alone)
                cen = np.array(raw)
                for i, e in enumerate(cy):
                    bri, ring = feats[i] if feats[i] else (None, None)
                    if bri is None:
                        e["note"] = GM["crash"]
                        continue
                    if ring is None:
                        k = int(np.argmin(np.abs(cen[:, 0] - bri)))
                    else:
                        k = int(np.argmin(((cen - [bri, ring]) / (f.std(axis=0) + 1e-9)) ** 2 @ [1, 1]))
                    e["note"] = GM["crash"] if k == crash_k else GM["ride"]
                return
    jump = None
    if env is not None:
        jump = np.array([np.log1p(env.onset("hi", int(round(t * FPS))) * 1e3) for t in times])
    rings = np.array([f[1] if f and f[1] is not None else np.nan for f in (feats or [None] * len(cy))])
    for i, e in enumerate(cy):
        win = (times > e["time"] - 1.2) & (times < e["time"] + 1.2)
        if win.sum() >= 4:
            r = rings[win]
            r = r[~np.isnan(r)]
            crash_stream = len(r) >= 2 and float(np.median(r)) > RING_CRASH
            loud = jump is not None and jump[i] > np.median(jump[win]) + 1.2
            e["note"] = GM["crash"] if (crash_stream or loud) else GM["ride"]
        else:
            e["note"] = GM["crash"]


def _pan(env: Envelopes, t: float):
    if env.get("hi", "L") is None:
        return None
    fi = int(round(t * FPS))
    l, r = env.onset("hi", fi, "L"), env.onset("hi", fi, "R")
    if l + r <= 0:
        return None
    return (r - l) / (r + l)


def assign_crashes(crashes, hh, events, env: Envelopes):
    """Kits with two crashes: tell them apart.
    1. By where they sit in the stereo mix (the hi-hat side tells us which is the
       left crash). Then the result is marked as heard.
    2. Otherwise by how the hands move: a fill that runs down the toms ends on the
       right side of the kit, so the crash after it is most likely the right one.
       These guesses are marked how='hand' and only shown on a 2-crash kit."""
    if not crashes:
        return
    pans = [_pan(env, e["time"]) for e in crashes]
    ok = [p for p in pans if p is not None]
    if len(ok) >= 6 and len(ok) >= 0.8 * len(crashes):
        lab, c = _two_means(np.array(ok))
        c = c[:, 0]
        share = lab.mean()
        if abs(c[0] - c[1]) > 0.3 and 0.15 <= share <= 0.85:
            # which side is the drummer's left? the hi-hat's side (hats heard on their
            # own, not over a ringing cymbal), else opposite the ride
            cym_t = np.array(sorted(e["time"] for e in events if e["label"] == CYM))
            def clear(t):
                k = int(np.searchsorted(cym_t, t)) - 1
                return k < 0 or t - cym_t[k] > 1.0
            hp = [p for p in (_pan(env, e["time"]) for e in hh[:600] if clear(e["time"])) if p is not None]
            hh_side = float(np.median(hp)) if len(hp) >= 8 else 0.0
            if abs(hh_side) < 0.05:
                rp = [p for p in (_pan(env, e["time"]) for e in events
                                  if e["label"] == CYM and e.get("note") == GM["ride"]) if p is not None]
                hh_side = -float(np.median(rp)) if len(rp) >= 8 else 0.0
            if abs(hh_side) < 0.05:
                hh_side = -1.0          # unknown: assume the left speaker is the drummer's left
            left_k = int(np.argmin(np.abs(c - np.sign(hh_side))))
            it = iter(lab)
            for e, p in zip(crashes, pans):
                if p is None:
                    continue
                e["note"] = GM["crash"] if next(it) == left_k else GM["crash2"]
            return
    # the hands
    drums_by_time = sorted((e for e in events if e["label"] in (TOM, SNARE)), key=lambda e: e["time"])
    times = np.array([e["time"] for e in drums_by_time])
    prev_c = None
    for e in crashes:
        t = e["time"]
        side = None
        if prev_c is not None and t - prev_c[0] < 0.7:
            side = prev_c[1]                      # repeated crashes: same cymbal
        else:
            k = int(np.searchsorted(times, t - 0.02)) - 1
            if k >= 0 and t - times[k] < 0.5:
                last = drums_by_time[k]
                if last["label"] == TOM and last.get("note") in (GM["tom_floor"], GM["tom_mid"]):
                    side = "R"
        if side == "R":
            e["note"] = GM["crash2"]
            e["how"] = "hand"
        prev_c = (t, side)
