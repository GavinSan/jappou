"""Score edits: replace the notes / hits / chords inside a time range, with
snapshots so every edit can be undone. The score (GP5) is then rebuilt from the
edited event lists, exactly like after analysis."""
from __future__ import annotations

import json
import re
import shutil

import pipeline

EDIT_FILES = ("drums.json", "notes.json", "chords.json")
PITCHED = ("vocals", "guitar", "bass", "other", "piano")


def _read(path, default):
    return json.loads(path.read_text("utf-8")) if path.exists() else default


def snapshot(job: pipeline.Job, label: str):
    root = job.folder / "edits"
    root.mkdir(exist_ok=True)
    nums = [int(d.name.split("_")[0]) for d in root.iterdir() if d.is_dir() and d.name.split("_")[0].isdigit()]
    snap = root / f"{1 + max(nums or [0]):04d}_{re.sub(r'[^a-z0-9]+', '', label.lower())[:20]}"
    snap.mkdir()
    for name in EDIT_FILES:
        if (job.folder / name).exists():
            shutil.copy2(job.folder / name, snap / name)
    for old in sorted(d for d in root.iterdir() if d.is_dir())[:-40]:  # keep the last 40 steps
        shutil.rmtree(old, ignore_errors=True)


def apply_edit(job: pipeline.Job, target: str, t0: float, t1: float, events: list[dict]) -> pipeline.Job:
    t0, t1 = float(t0), float(t1)
    if not (t1 > t0):
        raise ValueError("時間範圍唔啱")
    if target not in ("drums", "chords") + PITCHED:
        raise ValueError("唔識改呢樣")
    f = job.folder
    snapshot(job, target)
    if target == "drums":
        data = [d for d in _read(f / "drums.json", []) if not (t0 <= d["time"] < t1)]
        for e in events:
            data.append({"time": round(float(e["time"]), 4), "note": int(e["note"]), "vel": int(e.get("vel", 100))})
        data.sort(key=lambda d: d["time"])
        (f / "drums.json").write_text(json.dumps(data), "utf-8")
    elif target in PITCHED:
        notes = _read(f / "notes.json", {})
        keys = ["piano_rh", "piano_lh"] if target == "piano" else [target]
        for k in keys:
            notes[k] = [n for n in notes.get(k, []) if not (t0 <= n["start"] < t1)]
        for e in events:
            n = {"start": round(float(e["start"]), 4), "end": round(float(e["end"]), 4),
                 "pitch": int(e["pitch"]), "vel": int(e.get("vel", 90))}
            if n["end"] <= n["start"]:
                continue
            k = ("piano_rh" if n["pitch"] >= 60 else "piano_lh") if target == "piano" else target
            notes.setdefault(k, []).append(n)
        for k in keys:
            notes[k] = sorted(notes.get(k, []), key=lambda n: (n["start"], n["pitch"]))
        (f / "notes.json").write_text(json.dumps(notes), "utf-8")
    else:
        data = _read(f / "chords.json", {"key": "", "chords": []})
        out = []
        for c in data.get("chords", []):
            if c["end"] <= t0 or c["start"] >= t1:
                out.append(c)
                continue
            if c["start"] < t0:   # trim chords that overlap the edited range
                out.append({**c, "end": t0})
            if c["end"] > t1:
                out.append({**c, "start": t1})
        for e in events:
            name = str(e.get("name", "")).strip()[:16]
            if name:
                out.append({"start": round(float(e["start"]), 3), "end": round(float(e["end"]), 3), "name": name})
        out.sort(key=lambda c: c["start"])
        data["chords"] = out
        (f / "chords.json").write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    job = pipeline.Job(f)
    pipeline.rebuild_score(job)  # chords too: notes are split at chord changes
    job.set(edited=True, editCount=int(job.meta.get("editCount", 0)) + 1)
    return job


def undo(job: pipeline.Job):
    """Restore the last snapshot. Returns (job, steps_left) or None."""
    root = job.folder / "edits"
    snaps = sorted(d for d in root.iterdir() if d.is_dir()) if root.exists() else []
    if not snaps:
        return None
    last = snaps[-1]
    for name in EDIT_FILES:
        if (last / name).exists():
            shutil.copy2(last / name, job.folder / name)
        elif (job.folder / name).exists() and name == "chords.json":
            (job.folder / name).unlink()  # didn't exist before that edit
    shutil.rmtree(last, ignore_errors=True)
    job = pipeline.Job(job.folder)
    pipeline.rebuild_score(job)
    job.set(editCount=max(0, int(job.meta.get("editCount", 0)) - 1))
    return job, len(snaps) - 1
