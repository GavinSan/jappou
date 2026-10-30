"""Find published, time-synced lyrics online (LRCLIB, a free community lyrics
database) and line them up with the song's own vocal track.

Only used to *display* lyrics in this local app; nothing is uploaded.
"""
from __future__ import annotations

import json
import re
import ssl
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

API = "https://lrclib.net/api"
UA = "JapPouGei/2 (personal drum-chart app; local use)"

# ---------------------------------------------------------------- HTTP

_last_call = 0.0


def _get_json(path: str, params: dict | None = None, timeout: int = 15):
    global _last_call
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    for attempt in range(3):
        wait = 0.3 - (time.time() - _last_call)  # be polite: sequential, small gap
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (429, 503) and attempt < 2:
                time.sleep(float(e.headers.get("Retry-After") or 1) * 1.3)
                continue
            raise
    return None


def search(track: str = "", artist: str = "", q: str = "") -> list[dict]:
    params = {"q": q} if q else {"track_name": track, **({"artist_name": artist} if artist else {})}
    res = _get_json("/search", params) or []
    return [r for r in res if isinstance(r, dict)]


def get_by_id(lrclib_id: int) -> dict | None:
    return _get_json(f"/get/{int(lrclib_id)}")


# ---------------------------------------------------------------- titles

NOISE = [
    r"official\s*(music\s*)?video", r"official\s*mv", r"official\s*audio", r"official\s*lyric(s)?\s*video",
    r"lyric(s)?\s*video", r"music\s*video", r"\bmv\b", r"\bm/v\b", r"\bhd\b", r"\b4k\b", r"\bhq\b", r"\bfull\b",
    r"官方(完整|高清)?版?", r"高清", r"完整版", r"字幕版?", r"歌詞版?", r"歌词版?", r"動態歌詞", r"动态歌词",
    r"\blive\b", r"\bpv\b", r"\bvisualizer\b", r"\baudio\b", r"뮤직비디오", r"\bteaser\b",
]


def _strip_noise(s: str) -> str:
    s = re.sub(r"[\(\[【（［〔][^\)\]】）］〕]*[\)\]】）］〕]", " ", s)  # bracketed bits: (Official MV) 【MV】
    for pat in NOISE:
        s = re.sub(pat, " ", s, flags=re.I)
    s = re.sub(r"\s+", " ", s)
    return s.strip(" -–—_|:：·~")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = _to_trad(s)
    return re.sub(r"[\W_]+", "", s)


def queries_from_meta(meta: dict) -> list[dict]:
    """Candidate (track, artist) searches from what yt-dlp told us."""
    out: list[dict] = []

    def add(track, artist=""):
        track, artist = (track or "").strip(), (artist or "").strip()
        if track and {"track": track, "artist": artist} not in out:
            out.append({"track": track, "artist": artist})

    yt_track, yt_artist = meta.get("ytTrack"), meta.get("ytArtist")
    if yt_track:
        add(yt_track, yt_artist or "")
    raw = meta.get("ytTitle") or meta.get("title") or ""
    channel = re.sub(r"(?i)\s*(-\s*topic|vevo|official|官方頻道|官方频道|channel)\s*$", "", meta.get("channel") or meta.get("artist") or "").strip()
    quoted = re.findall(r"[《「『〈“\"]([^》」』〉”\"]+)[》」』〉”\"]", raw)
    for qt in quoted:
        before = raw.split(qt)[0]
        add(qt, _strip_noise(re.sub(r"[《「『〈“\"]", "", before)) or channel)
    clean = _strip_noise(raw)
    # "Artist - Track", "Artist｜Track", "陳奕迅-K歌之王" (but not "Spider-Man")
    parts = [p.strip() for p in re.split(r"\s+[-–—|｜]\s*|\s*[–—|｜]\s*|(?<=[^\x00-\x7f])-|-(?=[^\x00-\x7f])", clean)
             if p and p.strip()]
    if len(parts) >= 2:
        add(parts[1], parts[0])    # "Artist - Track"
        add(parts[0], parts[1])    # "Track - Artist"
    if clean:
        add(clean, channel)
        add(clean, "")
    return out[:6]


# ---------------------------------------------------------------- LRC parsing

CREDIT = re.compile(r"^\s*(作词|作詞|作曲|编曲|編曲|监制|監製|製作|制作|词|詞|曲|演唱|歌手|lyrics?|composer|arranger|producer|"
                    r"作詞者|作曲者|編曲者|和声|和聲|混音|母带|母帶|录音|錄音|吉他|贝斯|貝斯|鼓|键盘|鍵盤|弦乐|弦樂|出品|"
                    r"op|sp|ar|ti|al|by)\s*[:：]", re.I)
TS = re.compile(r"\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]")


def parse_lrc(text: str) -> list[dict]:
    lines = []
    offset = 0.0
    m = re.search(r"\[offset:\s*([+-]?\d+)\]", text or "", re.I)
    if m:
        offset = int(m.group(1)) / 1000.0
    for raw in (text or "").splitlines():
        stamps = TS.findall(raw)
        if not stamps:
            continue
        content = TS.sub("", raw).strip()
        content = re.sub(r"<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>", "", content).strip()  # enhanced word stamps
        for mm, ss in stamps:
            t = int(mm) * 60 + float(ss.replace(":", ".")) - offset
            lines.append({"start": max(0.0, t), "text": content})
    lines.sort(key=lambda x: x["start"])
    out = []
    for i, ln in enumerate(lines):
        nxt = lines[i + 1]["start"] if i + 1 < len(lines) else ln["start"] + 6
        if not ln["text"] or CREDIT.match(ln["text"]):
            continue
        out.append({"start": round(ln["start"], 3), "end": round(min(nxt, ln["start"] + 10), 3), "text": ln["text"]})
    return out


# ---------------------------------------------------------------- text helpers

_KANA = re.compile(r"[぀-ヿ]")
_HANGUL = re.compile(r"[가-힯]")
_HAN = re.compile(r"[㐀-鿿]")
_cc = None


def _to_trad(s: str) -> str:
    """Simplified -> Traditional (HK) for Chinese text; leaves Japanese alone."""
    global _cc
    if not _HAN.search(s) or _KANA.search(s):
        return s
    try:
        if _cc is None:
            from opencc import OpenCC
            _cc = OpenCC("s2hk")
        return _cc.convert(s)
    except Exception:
        return s


def detect_language(lines: list[dict]) -> str:
    text = "".join(l["text"] for l in lines)
    if _KANA.search(text):
        return "ja"
    if _HANGUL.search(text):
        return "ko"
    if _HAN.search(text):
        return "zh"
    return "en"


TOKEN = re.compile(r"[㐀-鿿぀-ヿ豈-﫿]|[가-힯]+|[A-Za-z0-9À-ÿ'’]+|[^\s]")


def approx_words(lines: list[dict]) -> list[dict]:
    """No per-word timing in plain LRC: spread each line's words across its sung time."""
    for i, ln in enumerate(lines):
        toks = [t for t in TOKEN.findall(ln["text"]) if re.search(r"\w", t)]
        if not toks:
            ln["words"] = []
            continue
        nxt = lines[i + 1]["start"] if i + 1 < len(lines) else ln["start"] + 8
        dur = max(0.6, min(nxt - ln["start"] - 0.15, 0.42 * len(toks) + 0.4, 9.0))
        step = dur / len(toks)
        words = []
        for j, t in enumerate(toks):
            latin = re.match(r"[A-Za-z0-9À-ÿ'’]|[가-힯]", t)
            w = (" " + t) if (latin and j > 0) else t
            words.append({"start": round(ln["start"] + j * step, 3), "end": round(ln["start"] + (j + 1) * step, 3), "word": w})
        ln["words"] = words
        ln["end"] = round(ln["start"] + dur, 3)
        ln["approx"] = True
    return lines


# ---------------------------------------------------------------- alignment

HOP = 0.05


def vocal_activity(vocal_wav: Path) -> np.ndarray:
    """Per-50ms frame: +1 if the singer is audible, -1 if not."""
    try:
        import soundfile as sf
        y, sr = sf.read(str(vocal_wav), dtype="float32", always_2d=True)
        y = y.mean(axis=1)
    except Exception:  # e.g. an mp3 stem on an older libsndfile
        import librosa
        y, sr = librosa.load(str(vocal_wav), sr=22050, mono=True)
    h = int(sr * HOP)
    n = len(y) // h
    rms = np.sqrt((y[: n * h].reshape(n, h) ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)
    thr = np.percentile(db, 95) - 22
    act = (db > thr).astype(np.float32)
    # bridge short gaps between syllables
    k = int(0.3 / HOP)
    act = np.convolve(act, np.ones(k), "same") > 0
    return np.where(act, 1.0, -1.0).astype(np.float32)


def align(lines: list[dict], activity: np.ndarray, max_shift: float = 60.0) -> tuple[float, float]:
    """Find the constant time shift that best matches lyric lines to singing.
    Returns (shift_seconds, quality 0..1)."""
    if not lines or len(activity) == 0:
        return 0.0, 0.0
    idx = []
    for i, ln in enumerate(lines):
        nxt = lines[i + 1]["start"] if i + 1 < len(lines) else ln["start"] + 5
        n_chars = max(1, len(re.sub(r"\s", "", ln["text"])))
        dur = min(nxt - ln["start"], max(1.2, 0.28 * n_chars + 0.6), 8.0)
        a, b = int(ln["start"] / HOP), int((ln["start"] + dur) / HOP)
        idx.extend(range(a, max(a + 1, b)))
    idx = np.unique(np.array(idx, dtype=np.int64))
    n = len(activity)
    pad = int(max_shift / HOP) + 2
    padded = np.concatenate([np.full(pad, -1.0, np.float32), activity, np.full(pad + int(idx.max()) + 2, -1.0, np.float32)])
    shifts = np.arange(-int(max_shift / HOP), int(max_shift / HOP) + 1)
    best_s, best = 0, -1e9
    for s in shifts:
        sc = padded[idx + s + pad].sum()
        if sc > best:
            best, best_s = sc, s
    shift = best_s * HOP
    # quality: share of line starts that land on singing (±0.4s)
    hits = 0
    for ln in lines:
        f = int((ln["start"] + shift) / HOP)
        lo, hi = max(0, f - 8), min(n, f + 8)
        if hi > lo and (activity[lo:hi] > 0).any():
            hits += 1
    return float(shift), hits / len(lines)


def shift_lines(lines: list[dict], shift: float) -> list[dict]:
    out = []
    for ln in lines:
        s = round(ln["start"] + shift, 3)
        e = round(ln.get("end", ln["start"] + 3) + shift, 3)
        if e <= 0:
            continue
        out.append({**ln, "start": max(0.0, s), "end": e})
    return out


# ---------------------------------------------------------------- pick + build

def _score(rec: dict, q: dict, title_norm: str, duration: float) -> float:
    tn, an = norm(rec.get("trackName", "")), norm(rec.get("artistName", ""))
    if not tn:
        return -1
    s = 0.0
    if tn == norm(q["track"]):
        s += 3
    elif tn in title_norm or norm(q["track"]) in tn:
        s += 1.5
    else:
        return -1
    if q["artist"]:
        qa = norm(q["artist"])
        if an and (an in qa or qa in an or an in title_norm):
            s += 2
        else:
            s -= 1
    elif an and an in title_norm:
        s += 1.5
    d = rec.get("duration") or 0
    if d and duration:
        diff = duration - d  # MVs are often longer (intro / outro), rarely much shorter
        if -8 <= diff <= 90:
            s += 1.0 - min(abs(diff), 60) / 120
        else:
            s -= 1.5
    if rec.get("syncedLyrics"):
        s += 1
    return s


def find_candidates(meta: dict, duration: float) -> list[dict]:
    title_norm = norm(meta.get("ytTitle") or meta.get("title") or "")
    found: dict[int, tuple[float, dict]] = {}
    for q in queries_from_meta(meta):
        try:
            res = search(q["track"], q["artist"])
            if not res and q["artist"]:
                res = search(q["track"])
        except Exception as exc:  # noqa: BLE001
            print("[lyrics] LRCLIB search failed:", exc)
            return []
        for r in res:
            if r.get("instrumental"):
                continue
            sc = _score(r, q, title_norm, duration)
            if sc > 0 and (r["id"] not in found or found[r["id"]][0] < sc):
                found[r["id"]] = (sc, r)
        if any(sc >= 5 and r.get("syncedLyrics") for sc, r in found.values()):
            break
    ranked = sorted(found.values(), key=lambda x: -x[0])
    return [r for _, r in ranked]


def build_from_record(rec: dict, vocal_wav: Path | None) -> dict | None:
    """Turn an LRCLIB record into our lyrics.json structure, aligned to the vocals."""
    if not rec or not rec.get("syncedLyrics"):
        return None
    lines = parse_lrc(rec["syncedLyrics"])
    if len(lines) < 3:
        return None
    for ln in lines:
        ln["text"] = _to_trad(ln["text"])
    shift, quality = 0.0, None
    if vocal_wav and Path(vocal_wav).exists():
        act = vocal_activity(Path(vocal_wav))
        shift, quality = align(lines, act)
        lines = shift_lines(lines, shift)
    lines = approx_words(lines)
    return {
        "language": detect_language(lines),
        "lines": lines,
        "source": "lrclib",
        "sourceInfo": {"id": rec.get("id"), "track": rec.get("trackName"), "artist": rec.get("artistName"),
                       "album": rec.get("albumName"), "shift": round(shift, 2),
                       "quality": None if quality is None else round(quality, 2)},
    }


def fetch_best(meta: dict, duration: float, vocal_wav: Path, min_quality: float = 0.55, log=print) -> dict | None:
    """Auto mode used during analysis: best synced match whose timing fits the vocals."""
    cands = [c for c in find_candidates(meta, duration) if c.get("syncedLyrics")][:3]
    for rec in cands:
        data = build_from_record(rec, vocal_wav)
        if not data:
            continue
        q = data["sourceInfo"]["quality"]
        log(f"網上歌詞候選：{rec.get('artistName')} - {rec.get('trackName')}（吻合度 {q:.0%}，偏移 {data['sourceInfo']['shift']:+.1f}s）")
        if q is not None and q >= min_quality:
            return data
    return None
