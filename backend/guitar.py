"""Split the guitar into two band-friendly parts:

* Chord part (結他 Chord): strum times detected from the guitar stem, each played
  as a standard chord shape of the chord sounding at that moment -> shown as
  rhythm slashes + chord names + diagrams.
* Solo part (結他 Solo): single-note lines from the note transcription, with
  everything that is probably not a lead line removed: notes inside strummed
  chords, bleed from the singer / piano, very quiet notes and isolated blips.

Sensitivity (low / mid / high) controls how much is kept.
"""
from __future__ import annotations

import re

import numpy as np

SENS = {
    # strum strength, solo loudness, min notes per phrase, "how solo-like" a phrase must be
    "low": dict(strum=0.42, amp=0.42, phrase=5, lead=1.40),
    "mid": dict(strum=0.28, amp=0.33, phrase=4, lead=1.22),
    "high": dict(strum=0.16, amp=0.24, phrase=3, lead=1.02),
}
TUNING = [40, 45, 50, 55, 59, 64]   # low E -> high e


# ---------------------------------------------------------------- strum detection

def detect_strums(y: np.ndarray, sr: int) -> list[dict]:
    """Onsets in the guitar stem -> [{time, s}] with strength s in 0..1."""
    from scipy.signal import resample_poly
    if y.ndim == 2:
        y = y.mean(axis=1)
    target = 22050
    if sr != target:
        from math import gcd
        g = gcd(int(sr), target)
        y = resample_poly(y, target // g, int(sr) // g)
    y = y.astype(np.float32)
    n_fft, hop = 2048, 256
    n = 1 + max(0, (len(y) - n_fft) // hop)
    if n < 4:
        return []
    win = np.hanning(n_fft).astype(np.float32)
    out = []
    flux = np.zeros(n, np.float32)
    rms = np.zeros(n, np.float32)
    freqs = np.fft.rfftfreq(n_fft, 1 / target)
    band = (freqs >= 150) & (freqs <= 5000)
    prev = None
    step = 2048  # frames per chunk (keeps memory low on long songs)
    for a in range(0, n, step):
        b = min(n, a + step)
        idx = np.arange(n_fft)[None, :] + hop * np.arange(a, b)[:, None]
        fr = y[idx] * win
        S = np.abs(np.fft.rfft(fr, axis=1))[:, band]
        rms[a:b] = np.sqrt((fr ** 2).mean(axis=1))
        L = np.log1p(10.0 * S)
        if prev is not None:
            L = np.vstack([prev[None, :], L])
            d = np.maximum(0.0, np.diff(L, axis=0)).sum(axis=1)
        else:
            d = np.concatenate([[0.0], np.maximum(0.0, np.diff(L, axis=0)).sum(axis=1)])
        flux[a:b] = d
        prev = L[-1]
    # smooth + normalise
    flux = np.convolve(flux, np.hanning(5) / np.hanning(5).sum(), "same")
    ref = np.percentile(flux, 98) + 1e-9
    f = flux / ref
    db = 20 * np.log10(rms + 1e-9)
    alive = db > np.percentile(db, 95) - 35
    fps = target / hop
    w = int(0.1 * fps)
    local = np.convolve(f, np.ones(2 * w + 1) / (2 * w + 1), "same")
    near = int(0.05 * fps)
    last = -1e9
    for i in range(1, n - 1):
        if not alive[i]:
            continue
        lo, hi = max(0, i - near), min(n, i + near + 1)
        if f[i] < f[lo:hi].max() or f[i] < local[i] + 0.06 or f[i] < 0.08:
            continue
        t = (i * hop + n_fft / 2) / target
        if t - last < 0.07:
            continue
        out.append({"time": round(float(t), 4), "s": round(float(min(1.0, f[i])), 3)})
        last = t
    return out


# ---------------------------------------------------------------- chord shapes

NOTE_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
IV = {"": [0, 4, 7], "m": [0, 3, 7], "7": [0, 4, 7, 10], "maj7": [0, 4, 7, 11], "m7": [0, 3, 7, 10],
      "sus4": [0, 5, 7], "sus2": [0, 2, 7], "dim": [0, 3, 6], "m7b5": [0, 3, 6, 10], "aug": [0, 4, 8],
      "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9], "9": [0, 4, 7, 10, 2], "add9": [0, 4, 7, 2], "7sus4": [0, 5, 7, 10]}
ALIAS = {"M7": "maj7", "Maj7": "maj7", "min": "m", "-": "m", "min7": "m7", "-7": "m7", "+": "aug", "M": ""}
OPEN = {
    "C": [-1, 3, 2, 0, 1, 0], "A": [-1, 0, 2, 2, 2, 0], "G": [3, 2, 0, 0, 0, 3], "E": [0, 2, 2, 1, 0, 0], "D": [-1, -1, 0, 2, 3, 2],
    "Am": [-1, 0, 2, 2, 1, 0], "Em": [0, 2, 2, 0, 0, 0], "Dm": [-1, -1, 0, 2, 3, 1],
    "A7": [-1, 0, 2, 0, 2, 0], "E7": [0, 2, 0, 1, 0, 0], "D7": [-1, -1, 0, 2, 1, 2], "G7": [3, 2, 0, 0, 0, 1], "C7": [-1, 3, 2, 3, 1, 0], "B7": [-1, 2, 1, 2, 0, 2],
    "Am7": [-1, 0, 2, 0, 1, 0], "Em7": [0, 2, 0, 0, 0, 0], "Dm7": [-1, -1, 0, 2, 1, 1],
    "Cmaj7": [-1, 3, 2, 0, 0, 0], "Fmaj7": [-1, -1, 3, 2, 1, 0], "Amaj7": [-1, 0, 2, 1, 2, 0], "Dmaj7": [-1, -1, 0, 2, 2, 2], "Gmaj7": [3, -1, 0, 0, 0, 2], "Emaj7": [0, 2, 1, 1, 0, 0],
    "Asus4": [-1, 0, 2, 2, 3, 0], "Dsus4": [-1, -1, 0, 2, 3, 3], "Esus4": [0, 2, 2, 2, 0, 0], "Asus2": [-1, 0, 2, 2, 0, 0], "Dsus2": [-1, -1, 0, 2, 3, 0],
}
SHAPES = {
    "": ([0, 2, 2, 1, 0, 0], [-1, 0, 2, 2, 2, 0]), "m": ([0, 2, 2, 0, 0, 0], [-1, 0, 2, 2, 1, 0]),
    "7": ([0, 2, 0, 1, 0, 0], [-1, 0, 2, 0, 2, 0]), "maj7": ([0, -1, 1, 1, 0, -1], [-1, 0, 2, 1, 2, 0]),
    "m7": ([0, 2, 0, 0, 0, 0], [-1, 0, 2, 0, 1, 0]), "sus4": ([0, 2, 2, 2, 0, 0], [-1, 0, 2, 2, 3, 0]),
    "sus2": ([0, 2, 4, 4, 0, 0], [-1, 0, 2, 2, 0, 0]), "dim": ([0, 1, 2, 0, -1, -1], [-1, 0, 1, 2, 1, -1]),
    "m7b5": ([0, -1, 0, 0, -1, -1], [-1, 0, 1, 0, 1, -1]), "7sus4": ([0, 2, 0, 2, 0, 0], [-1, 0, 2, 0, 3, 0]),
    "6": ([0, -1, -1, 1, 2, 0], [-1, 0, 2, 2, 2, 2]), "m6": ([0, -1, -1, 0, 2, 0], [-1, 0, 2, 2, 1, 2]),
    "9": ([0, -1, 0, 1, 0, 2], [-1, 0, -1, 0, 0, 0]), "aug": ([0, 3, 2, 1, 1, 0], [-1, 0, 3, 2, 2, 1]),
}
SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def parse_chord(name: str):
    m = re.match(r"^\s*([A-G])([#b♯♭]?)([^/\s]*)(?:/([A-G])([#b♯♭]?))?\s*$", name or "")
    if not m:
        return None
    acc = lambda a: 1 if a in ("#", "♯") else -1 if a in ("b", "♭") else 0  # noqa: E731
    root = (NOTE_PC[m.group(1)] + acc(m.group(2))) % 12
    q = ALIAS.get(m.group(3), m.group(3))
    if q not in IV:
        q = "m" if q.startswith("m") and not q.startswith("maj") else ""
    bass = (NOTE_PC[m.group(4)] + acc(m.group(5))) % 12 if m.group(4) else root
    return {"root": root, "q": q, "bass": bass, "tones": [(root + i) % 12 for i in IV[q]]}


def _span(v):
    f = [x for x in v if x > 0]
    return max(f) - min(f) if f else 0


def voicing(c) -> list[int] | None:
    """Same rules as the front end (shared.js guitarVoicing): frets low E -> high e, -1 = muted."""
    if not c:
        return None
    q = c["q"] if c["q"] in SHAPES else ("m" if c["q"].startswith("m") else "")
    cands = []
    for names in (SHARP, FLAT):
        key = names[c["root"]] + c["q"]
        if key in OPEN:
            cands.append(list(OPEN[key]))
    fE = (c["root"] - 4) % 12 or 12
    fA = (c["root"] - 9) % 12 or 12
    e = [-1 if v < 0 else v + fE for v in SHAPES[q][0]]
    a = [-1 if v < 0 else v + fA for v in SHAPES[q][1]]
    cands += [e, a] if fE <= fA else [a, e]
    if c["bass"] == c["root"]:
        return cands[0]
    best, best_cost = None, 1e9
    for ci, shape in enumerate(cands):
        for s in range(3):
            for f in range(15):
                if (TUNING[s] + f) % 12 != c["bass"]:
                    continue
                v = list(shape)
                for k in range(s):
                    v[k] = -1
                v[s] = f
                if sum(1 for x in v if x >= 0) < 3 or _span(v) > 4:
                    continue
                cost = _span(v) * 3 + ci + s * 0.5 + min([x for x in v if x > 0] + [0]) * 0.1
                if cost < best_cost:
                    best, best_cost = v, cost
    return best or cands[0]


# ---------------------------------------------------------------- parts

def _clusters(notes, win=0.05):
    """Group note starts that happen together (a strum / chord)."""
    ns = sorted(notes, key=lambda n: n["start"])
    groups, cur = [], []
    for n in ns:
        if cur and n["start"] - cur[0]["start"] > win:
            groups.append(cur)
            cur = []
        cur.append(n)
    if cur:
        groups.append(cur)
    return groups


def phrase_score(r: list[dict], chords: list[dict]) -> float:
    """How much a run of single notes looks like a solo line (vs a picked chord)."""
    def chord_at(t):
        for c in chords:
            if c["start"] <= t < c["end"]:
                return parse_chord(c["name"])
        return None
    ct = []
    for n in r:
        c = chord_at(n["start"])
        ct.append(1.0 if (c and n["pitch"] % 12 in c["tones"]) else 0.0)
    ct_ratio = float(np.mean(ct)) if ct else 1.0
    iv = [abs(b["pitch"] - a["pitch"]) for a, b in zip(r, r[1:])]
    step = float(np.mean([0 < x <= 3 for x in iv])) if iv else 0.0
    overlap = float(np.mean([a["end"] > b["start"] + 0.05 for a, b in zip(r, r[1:])])) if len(r) > 1 else 0.0
    high = max(0.0, (float(np.mean([n["pitch"] for n in r])) - 64) / 12)
    return (1 - ct_ratio) + 1.2 * step + 0.6 * (1 - overlap) + 0.5 * high


def lead_part(raw: list[dict], others: list[list[dict]], strums: list[dict], sens: str = "mid",
              chords: list[dict] | None = None) -> list[dict]:
    """Single-note solo line from the raw guitar transcription."""
    P = SENS.get(sens, SENS["mid"])
    if not raw:
        return []
    strum_t = np.array(sorted(s["time"] for s in strums if s["s"] >= P["strum"])) if strums else np.array([])
    other = [n for part in others for n in part]
    other_by_pitch: dict[int, list[tuple[float, float]]] = {}
    for n in other:
        other_by_pitch.setdefault(n["pitch"], []).append((n["start"], n["end"]))
    cand = []
    for g in _clusters(raw):
        if len(g) >= 3:
            continue                                  # a chord, not a lead line
        n = max(g, key=lambda x: (x["vel"], x["pitch"]))
        if n["vel"] / 127.0 < P["amp"] or n["pitch"] < 50:
            continue
        if n["end"] - n["start"] < 0.07 and n["vel"] / 127.0 < P["amp"] + 0.15:
            continue                                  # tiny blips
        # bleed: the singer / piano plays the same pitch at the same moment
        if any(abs(s - n["start"]) < 0.12 and e > n["start"] for s, e in other_by_pitch.get(n["pitch"], [])):
            continue
        # notes that coincide with a big strum are usually part of that chord
        if len(strum_t):
            i = np.searchsorted(strum_t, n["start"])
            close = [abs(strum_t[j] - n["start"]) for j in (i - 1, i) if 0 <= j < len(strum_t)]
            if close and min(close) < 0.03 and len(g) >= 2:
                continue
        cand.append(dict(n))
    chords = chords or []
    # phrases: runs of notes close together. A phrase only counts as a solo if it
    # sounds like a melody line, not like a picked chord (arpeggio):
    #   solo  -> notes outside the chord, stepwise motion, one note at a time, higher up
    #   arpeggio -> almost only chord tones, leaps, notes left ringing
    cand.sort(key=lambda n: n["start"])
    phrases, run = [], []
    for n in cand:
        if run and n["start"] - run[-1]["end"] > 0.6:
            phrases.append(run)
            run = []
        run.append(n)
    if run:
        phrases.append(run)
    out = []
    for r in phrases:
        if len(r) < P["phrase"]:
            continue
        if phrase_score(r, chords) >= P["lead"]:
            out.extend(r)
    for a, b in zip(out, out[1:]):                    # one note at a time
        if a["end"] > b["start"]:
            a["end"] = max(a["start"] + 0.05, b["start"])
    return out


def rhythm_part(strums: list[dict], chords: list[dict], raw: list[dict], lead: list[dict],
                end_time: float, sens: str = "mid", snap=None) -> list[dict]:
    """Chord shapes on each strum while the guitar is playing chords."""
    P = SENS.get(sens, SENS["mid"])
    if not strums or not chords:
        return []
    raw_starts = np.array(sorted(n["start"] for n in raw)) if raw else np.array([])
    lead_starts = np.array(sorted(n["start"] for n in lead)) if lead else np.array([])
    chords = sorted(chords, key=lambda c: c["start"])
    sel = []
    for s in sorted(strums, key=lambda s: s["time"]):
        if s["s"] < P["strum"]:
            continue
        t = s["time"]
        # an attack that is just a solo note is not a strum
        if len(lead_starts):
            i = np.searchsorted(lead_starts, t)
            if any(0 <= j < len(lead_starts) and abs(lead_starts[j] - t) < 0.04 for j in (i - 1, i)):
                if len(raw_starts) and np.sum(np.abs(raw_starts - t) < 0.05) < 2:
                    continue
        sel.append(t)
    if snap is not None:
        # band-chart rhythm: one strum per 8th (16th on high sensitivity), the strongest wins
        strength = {x["time"]: x["s"] for x in strums}
        best: dict = {}
        for t in sel:
            key, tq = snap(t)
            if key not in best or strength.get(t, 0) > best[key][0]:
                best[key] = (strength.get(t, 0), tq)
        sel = sorted(tq for _s, tq in best.values())
    out = []
    ci = 0
    for k, t in enumerate(sel):
        while ci < len(chords) and chords[ci]["end"] <= t:
            ci += 1
        if ci >= len(chords) or chords[ci]["start"] > t + 0.05:
            continue
        c = parse_chord(chords[ci]["name"])
        v = voicing(c)
        if not v:
            continue
        nxt = sel[k + 1] if k + 1 < len(sel) else min(end_time, t + 2.0)
        end = min(nxt, chords[ci]["end"], t + 3.0)
        if end - t < 0.05:
            end = t + 0.1
        for i, f in enumerate(v):
            if f < 0:
                continue
            out.append({"start": t, "end": end, "pitch": TUNING[i] + f, "vel": 90,
                        "string": 6 - i, "fret": f})   # GP string 1 = high e
    return out
