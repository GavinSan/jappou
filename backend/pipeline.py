"""The analysis pipeline for one song. Each stage writes its results into the job
folder so the UI can show partial results and a failed optional stage does not
kill the whole job."""
from __future__ import annotations

import json
import shutil
import time
import traceback
from pathlib import Path

import audio_utils as au

STAGES = [
    ("download", "下載音訊", 0.05),
    ("separate", "分離樂器（Demucs）", 0.35),
    ("beats", "搵拍子同小節", 0.05),
    ("drums", "執鼓譜", 0.08),
    ("pitched", "執其他樂器譜", 0.22),
    ("lyrics", "搵歌詞", 0.20),
    ("score", "整樂譜", 0.03),
    ("encode", "整理音軌", 0.02),
]


class Job:
    def __init__(self, folder: Path):
        self.folder = folder
        self.meta_path = folder / "meta.json"
        self.meta = json.loads(self.meta_path.read_text("utf-8")) if self.meta_path.exists() else {}

    def save(self):
        tmp = self.meta_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.meta, ensure_ascii=False, indent=1), "utf-8")
        tmp.replace(self.meta_path)

    def set(self, **kw):
        self.meta.update(kw)
        self.save()

    def log(self, msg: str):
        print(f"[{self.meta.get('id')}] {msg}")
        logs = self.meta.setdefault("log", [])
        logs.append(f"{time.strftime('%H:%M:%S')} {msg}")
        self.meta["log"] = logs[-60:]
        self.save()

    def stage(self, key: str, frac: float = 0.0):
        done = 0.0
        label = key
        for k, lab, w in STAGES:
            if k == key:
                label = lab
                done += w * frac
                break
            done += w
        self.set(stage=key, stageLabel=label, progress=round(min(done, 0.999), 3))


def device_name():
    """cuda (NVIDIA) > mps (Apple Silicon) > cpu"""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def on_device(fn, dev, job=None, what=""):
    """Run fn(dev); if the GPU path fails (e.g. an op not supported on Apple MPS), retry on CPU."""
    try:
        return fn(dev)
    except Exception as exc:  # noqa: BLE001
        if dev == "cpu":
            raise
        traceback.print_exc()
        if job:
            job.log(f"{what} 用 {dev.upper()} 失敗，轉用 CPU 再試（{str(exc)[:80]}）")
        try:
            import torch
            if dev == "mps":
                torch.mps.empty_cache()
            elif dev == "cuda":
                torch.cuda.empty_cache()
        except Exception:
            pass
        return fn("cpu")


def write_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False), "utf-8")


def run(job: Job):
    f = job.folder
    stems_dir = f / "stems"
    work = f / "work"
    work.mkdir(exist_ok=True)
    stems_dir.mkdir(exist_ok=True)
    dev = device_name()
    job.set(status="running", error=None, device=dev, started=time.time())
    job.log(f"用緊 {dev.upper()}")
    warnings = []
    try:
        # ------------------------------------------------------------ download
        job.stage("download")
        src = job.meta.get("source", {})
        mix = work / "mix.wav"
        if src.get("type") == "youtube":
            raw = download_youtube(src["url"], work, job)
        else:
            raw = f / src["file"]
        au.to_wav(raw, mix)
        y, sr = au.load(mix)
        duration = len(y) / sr
        job.set(duration=round(duration, 2))
        del y

        # ------------------------------------------------------------ separate
        job.stage("separate")
        from separate import separate, detect_instruments
        job.log("分離緊樂器，第一次會下載模型（大約 80MB）…")
        stem_wavs = on_device(lambda d: separate(mix, work / "stems", d, progress=lambda p: job.stage("separate", p)),
                              dev, job, "分離樂器")
        inst = detect_instruments(stem_wavs, mix)
        job.set(instruments=inst)
        job.log("偵測到樂器：" + "、".join(k for k, v in inst.items() if v["present"]))

        # ------------------------------------------------------------ beats
        job.stage("beats")
        from beats import track
        from timing import build_grid
        b, d, method = on_device(lambda dv: track(mix, dv), dev, job, "搵拍子")
        write_json(f / "beats_raw.json", {"beats": [float(x) for x in b], "downbeats": [float(x) for x in d],
                                          "duration": duration, "method": method})
        grid = build_grid(b, d, duration)
        job.set(bpm=round(grid.bpm, 1), beatsPerBar=grid.beats_per_bar)
        job.log(f"BPM 大約 {grid.bpm:.0f}，{grid.beats_per_bar}/4 拍（{method}）")

        # ------------------------------------------------------------ chords
        try:
            import chords as chordmod
            timing0 = grid.to_json()
            ch = chordmod.run_for_job(f, stem_wavs, timing0, au.load)
            write_json(f / "chords.json", {"key": chordmod.key_name(ch) if ch else "", "chords": ch})
            if ch:
                job.set(key=chordmod.key_name(ch))
                job.log(f"和弦：{len(ch)} 個，調性大約 {chordmod.key_name(ch)}")
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            warnings.append(f"認和弦失敗：{exc}")

        # ------------------------------------------------------------ drums
        job.stage("drums")
        drums = []
        try:
            from drums import transcribe_drums
            drums = on_device(lambda d: transcribe_drums(stem_wavs["drums"], d), dev, job, "執鼓譜")
            write_json(f / "drums.json", drums)
            job.log(f"鼓：{len(drums)} 下")
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            warnings.append(f"執鼓譜失敗：{exc}")

        # ------------------------------------------------------------ pitched
        job.stage("pitched")
        pitched = {}
        try:
            import pitched as pt
            todo = [s for s in ("vocals", "bass", "guitar", "piano", "other")
                    if inst.get(s, {}).get("present")]
            for i, s in enumerate(todo):
                job.stage("pitched", i / max(1, len(todo)))
                notes = pt.transcribe(stem_wavs[s], s)
                if s == "piano":
                    rh, lh = pt.split_hands(notes)
                    pitched["piano_rh"], pitched["piano_lh"] = rh, lh
                else:
                    pitched[s] = notes
                job.log(f"{s}：{len(notes)} 粒音")
            write_json(f / "notes.json", pitched)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            warnings.append(f"執其他樂器譜失敗：{exc}")

        # ------------------------------------------------------------ lyrics
        job.stage("lyrics")
        lyr = {"language": "", "lines": []}
        if inst.get("vocals", {}).get("present", True) and job.meta.get("lyrics", True):
            # 1) published, time-synced lyrics from the internet (LRCLIB), lined up with the vocals
            try:
                import lyrics_online
                job.log("上網搵緊歌詞…")
                found = lyrics_online.fetch_best(job.meta, duration, stem_wavs["vocals"], log=job.log)
                if found:
                    lyr = found
                    si = found["sourceInfo"]
                    job.log(f"用網上歌詞：{si['artist']} - {si['track']}（{len(found['lines'])} 句）")
                else:
                    job.log("網上搵唔到啱嘅歌詞，改為自己聽寫")
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                job.log(f"網上歌詞失敗（{str(exc)[:80]}），改為自己聽寫")
            # 2) otherwise transcribe the vocal track with Whisper
            if not lyr["lines"]:
                job.stage("lyrics", 0.2)
                try:
                    import lyrics
                    job.log("聽寫緊歌詞，第一次會下載 Whisper 模型（1–3GB）…")
                    lyr = lyrics.transcribe(stem_wavs["vocals"], job.meta.get("language", "auto"),
                                            job.meta.get("whisperModel"), dev)
                    lyr["source"] = "whisper"
                    job.log(f"歌詞：{len(lyr['lines'])} 句（{lyr.get('language')}，{lyr.get('model')}）")
                except Exception as exc:  # noqa: BLE001
                    traceback.print_exc()
                    warnings.append(f"聽寫歌詞失敗：{exc}")
        write_json(f / "lyrics.json", lyr)

        # ------------------------------------------------------------ score
        job.stage("score")
        rebuild_score(job)

        # ------------------------------------------------------------ encode
        job.stage("encode")
        for name, p in stem_wavs.items():
            au.to_mp3(p, stems_dir / f"{name}.mp3")
        job.set(stems=sorted(stem_wavs))
        shutil.rmtree(work, ignore_errors=True)
        job.set(status="done", progress=1.0, stage="done", stageLabel="完成", warnings=warnings,
                finished=time.time())
        job.log("完成！")
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        job.set(status="error", error=str(exc), warnings=warnings)
        job.log("出錯：" + str(exc))


def rebuild_score(job: Job, options: dict | None = None):
    """(Re)generate score.gp5 + timing.json from the saved analysis results.
    options: meter (int|None), shift (int), tempoFactor (1|2|0.5), triplets (bool)."""
    from score import build_song, write_gp5
    from timing import build_grid

    f = job.folder
    opts = {"meter": None, "shift": 0, "tempoFactor": 1, "triplets": True}
    opts.update(job.meta.get("scoreOptions") or {})
    if options:
        opts.update({k: v for k, v in options.items() if k in opts})
    raw = json.loads((f / "beats_raw.json").read_text("utf-8"))
    grid = build_grid(raw["beats"], raw["downbeats"], raw["duration"], meter=opts["meter"],
                      shift=int(opts["shift"] or 0), tempo_factor=float(opts["tempoFactor"] or 1))
    drums = json.loads((f / "drums.json").read_text("utf-8")) if (f / "drums.json").exists() else []
    pitched = json.loads((f / "notes.json").read_text("utf-8")) if (f / "notes.json").exists() else {}
    hidden = set(job.meta.get("hiddenTracks") or [])
    pitched = {k: v for k, v in pitched.items() if k not in hidden}
    chord_times = []
    if (f / "chords.json").exists():
        try:
            chord_times = [c["start"] for c in json.loads((f / "chords.json").read_text("utf-8")).get("chords", [])]
        except Exception:
            pass
    song, tracks = build_song(grid, job.meta.get("title", ""), job.meta.get("artist", ""),
                              drums if "drums" not in hidden else [], pitched,
                              allow_triplets=bool(opts["triplets"]), chord_times=chord_times)
    write_gp5(song, str(f / "score.gp5"))
    write_json(f / "timing.json", grid.to_json())
    from score import SCORE_FORMAT
    job.set(scoreFormat=SCORE_FORMAT, tracks=tracks, scoreOptions=opts, bpm=round(grid.bpm, 1), beatsPerBar=grid.beats_per_bar,
            scoreVersion=int(job.meta.get("scoreVersion", 0)) + 1)


def download_youtube(url: str, work: Path, job: Job) -> Path:
    import yt_dlp

    def hook(d):
        if d.get("status") == "downloading":
            tot = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if tot:
                job.stage("download", d.get("downloaded_bytes", 0) / tot)

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(work / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        path = Path(ydl.prepare_filename(info))
    title = info.get("track") or info.get("title") or ""
    artist = info.get("artist") or info.get("uploader") or ""
    job.set(title=title, artist=artist, thumbnail=info.get("thumbnail"),
            ytTitle=info.get("title") or "", ytTrack=info.get("track") or "", ytArtist=info.get("artist") or "",
            channel=info.get("channel") or info.get("uploader") or "")
    job.log(f"下載咗：{title}")
    if not path.exists():
        cands = list(work.glob("source.*"))
        if not cands:
            raise RuntimeError("下載失敗")
        path = cands[0]
    return path
