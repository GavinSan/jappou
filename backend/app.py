"""執譜機 local server.  Run:  python backend/app.py   then open http://localhost:8765"""
from __future__ import annotations

import json
import logging
import os
import queue
import re
import shutil
import sys
import threading
import time
import uuid
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
# Apple Silicon: let PyTorch fall back to CPU for ops the GPU (MPS) doesn't support
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from starlette.background import BackgroundTask  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import config  # noqa: E402
import export  # noqa: E402
import pipeline  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = config.DATA_DIR / "jobs"
DATA.mkdir(parents=True, exist_ok=True)
FRONTEND = ROOT / "frontend"
PORT = int(os.environ.get("JAPPOU_PORT", "8765"))
BASE_URL = f"http://127.0.0.1:{PORT}"

app = FastAPI(title="執譜機")


@app.middleware("http")
async def _no_stale_frontend(request, call_next):
    """Make the browser re-check the app's own HTML/JS/CSS on every load, so an
    updated version is picked up immediately (no hard refresh needed)."""
    resp = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/") and (path == "/" or path.endswith((".html", ".js", ".css"))):
        resp.headers["Cache-Control"] = "no-cache"
    return resp
work_q: "queue.Queue[str]" = queue.Queue()
_lock = threading.Lock()


def _worker():
    while True:
        job_id = work_q.get()
        try:
            job = pipeline.Job(DATA / job_id)
            pipeline.run(job)
            cfg = config.load()
            if job.meta.get("status") == "done" and cfg.get("autoExport") and cfg.get("exportDir"):
                _export(job_id)
        except Exception as exc:  # noqa: BLE001
            print("worker error", exc)
        work_q.task_done()


def _export(job_id: str):
    """Export one song to the configured folder (runs in the calling thread)."""
    job = pipeline.Job(DATA / job_id)
    job.set(exportStatus="running", exportError=None)
    try:
        export.export_job(job, config.load(), BASE_URL, log=job.log)
        job.set(exportStatus="done")
    except Exception as exc:  # noqa: BLE001
        job.set(exportStatus="error", exportError=str(exc))
        job.log("匯出失敗：" + str(exc))


def _maybe_reexport(job: pipeline.Job):
    """After edits, refresh an existing export if auto-export is on."""
    cfg = config.load()
    if cfg.get("autoExport") and cfg.get("exportDir") and job.meta.get("exported"):
        threading.Thread(target=_export, args=(job.meta["id"],), daemon=True).start()


threading.Thread(target=_worker, daemon=True).start()


def _job(job_id: str) -> pipeline.Job:
    if not re.fullmatch(r"[a-f0-9]{12}", job_id):
        raise HTTPException(404)
    f = DATA / job_id
    if not (f / "meta.json").exists():
        raise HTTPException(404, "搵唔到呢首歌")
    return pipeline.Job(f)


def _new_job(source: dict, language: str, lyrics: bool, title: str = "") -> dict:
    job_id = uuid.uuid4().hex[:12]
    f = DATA / job_id
    f.mkdir(parents=True)
    job = pipeline.Job(f)
    job.meta = {"id": job_id, "created": time.time(), "status": "queued", "stage": "queued",
                "stageLabel": "排緊隊", "progress": 0, "source": source, "language": language,
                "lyrics": lyrics, "title": title, "artist": "",
                "whisperModel": config.load().get("whisperModel", "auto")}
    job.save()
    return job


# ---------------------------------------------------------------- API

class NewJob(BaseModel):
    url: str
    language: str = "auto"
    lyrics: bool = True


YOUTUBE_RE = re.compile(r"^https?://(www\.|m\.|music\.)?(youtube\.com|youtu\.be)/", re.I)


@app.post("/api/jobs")
def create_job(body: NewJob):
    url = body.url.strip()
    if not YOUTUBE_RE.match(url):
        raise HTTPException(400, "請貼一條 YouTube 連結")
    job = _new_job({"type": "youtube", "url": url}, body.language, body.lyrics)
    work_q.put(job.meta["id"])
    return job.meta


@app.post("/api/upload")
async def upload_job(file: UploadFile = File(...), language: str = Form("auto"), lyrics: bool = Form(True)):
    name = Path(file.filename or "audio").name
    ext = Path(name).suffix.lower() or ".mp3"
    job = _new_job({"type": "file", "file": "upload" + ext}, language, lyrics, title=Path(name).stem)
    with open(job.folder / ("upload" + ext), "wb") as out:
        shutil.copyfileobj(file.file, out)
    work_q.put(job.meta["id"])
    return job.meta


@app.get("/api/jobs")
def list_jobs():
    out = []
    for f in DATA.iterdir():
        m = f / "meta.json"
        if m.exists():
            try:
                meta = json.loads(m.read_text("utf-8"))
                meta.pop("log", None)
                out.append(meta)
            except Exception:
                pass
    out.sort(key=lambda m: m.get("created", 0), reverse=True)
    return out


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return _job(job_id).meta


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job = _job(job_id)
    if job.meta.get("status") == "running":
        raise HTTPException(409, "分析緊，等佢做完先刪")
    shutil.rmtree(job.folder, ignore_errors=True)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str):
    job = _job(job_id)
    if job.meta.get("status") in ("running", "queued"):
        return job.meta
    job.set(status="queued", stage="queued", stageLabel="排緊隊", progress=0, error=None)
    work_q.put(job_id)
    return job.meta


class Meta(BaseModel):
    title: str | None = None
    artist: str | None = None


@app.patch("/api/jobs/{job_id}")
def patch_job(job_id: str, body: Meta):
    job = _job(job_id)
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    job.set(**upd)
    _maybe_reexport(job)
    return job.meta


class ScoreOptions(BaseModel):
    meter: int | None = None
    shift: int = 0
    tempoFactor: float = 1
    triplets: bool = True


@app.post("/api/jobs/{job_id}/rescore")
def rescore(job_id: str, body: ScoreOptions):
    job = _job(job_id)
    if job.meta.get("status") != "done":
        raise HTTPException(409, "未分析完")
    with _lock:
        pipeline.rebuild_score(job, body.model_dump())
    _maybe_reexport(job)
    return job.meta


@app.put("/api/jobs/{job_id}/lyrics")
def save_lyrics(job_id: str, body: dict):
    job = _job(job_id)
    lines = []
    for ln in body.get("lines", []):
        try:
            lines.append({"start": float(ln["start"]), "end": float(ln.get("end", ln["start"])),
                          "text": str(ln.get("text", ""))[:300], "words": ln.get("words") or []})
        except (KeyError, ValueError, TypeError):
            continue
    lines.sort(key=lambda x: x["start"])
    data = {"language": body.get("language", ""), "lines": lines, "edited": True}
    (job.folder / "lyrics.json").write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    _maybe_reexport(job)
    return data


@app.get("/api/jobs/{job_id}/lyrics/suggest")
def lyrics_suggest(job_id: str):
    """Best-guess song title / artist for the online lyrics search box."""
    import lyrics_online
    qs = lyrics_online.queries_from_meta(_job(job_id).meta)
    return qs[0] if qs else {"track": "", "artist": ""}


@app.get("/api/lyrics/search")
def lyrics_search(track: str = "", artist: str = ""):
    import lyrics_online
    if not track.strip():
        raise HTTPException(400, "請輸入歌名")
    try:
        res = lyrics_online.search(track.strip(), artist.strip())
        if not res and artist.strip():
            res = lyrics_online.search(track.strip())
        if not res:
            res = lyrics_online.search(q=f"{track} {artist}".strip())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"連唔到歌詞網站（lrclib.net）：{exc}")
    out = []
    for r in res[:20]:
        if r.get("instrumental"):
            continue
        plain = r.get("plainLyrics") or ""
        out.append({"id": r.get("id"), "track": r.get("trackName"), "artist": r.get("artistName"),
                    "album": r.get("albumName"), "duration": r.get("duration"),
                    "synced": bool(r.get("syncedLyrics")), "preview": " / ".join(plain.splitlines()[:2])[:80]})
    out.sort(key=lambda x: not x["synced"])
    return out


class ApplyLyrics(BaseModel):
    lrclibId: int


@app.post("/api/jobs/{job_id}/lyrics/apply")
def lyrics_apply(job_id: str, body: ApplyLyrics):
    """Use one online result. Synced lyrics are aligned to this recording and saved;
    plain (untimed) lyrics are returned for the editor to place."""
    import lyrics_online
    job = _job(job_id)
    try:
        rec = lyrics_online.get_by_id(body.lrclibId)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"連唔到歌詞網站：{exc}")
    if not rec:
        raise HTTPException(404, "搵唔到呢份歌詞")
    if not rec.get("syncedLyrics"):
        text = lyrics_online._to_trad(rec.get("plainLyrics") or "")
        return {"plain": text}
    vocal = job.folder / "stems" / "vocals.mp3"
    data = lyrics_online.build_from_record(rec, vocal if vocal.exists() else None)
    if not data:
        raise HTTPException(422, "呢份歌詞冇時間資料")
    (job.folder / "lyrics.json").write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    _maybe_reexport(job)
    return data


@app.post("/api/jobs/{job_id}/export")
def export_now(job_id: str):
    job = _job(job_id)
    if job.meta.get("status") != "done":
        raise HTTPException(409, "未分析完")
    if not config.load().get("exportDir"):
        raise HTTPException(400, "未設定匯出資料夾（主頁右上角「設定」）")
    if job.meta.get("exportStatus") == "running":
        return job.meta
    job.set(exportStatus="running", exportError=None)
    threading.Thread(target=_export, args=(job_id,), daemon=True).start()
    return job.meta


@app.get("/api/jobs/{job_id}/pdf")
def job_pdf(job_id: str, chip: str = "drums", lyrics: str = "line", bars: int = 4, stave: str = "auto"):
    job = _job(job_id)
    if chip not in export.CHIP_TRACKS or lyrics not in ("line", "word", "off") or stave not in ("auto", "score", "tab"):
        raise HTTPException(400)
    try:
        path = export.render_single_pdf(BASE_URL, job_id, chip, lyrics, max(0, min(8, bars)), stave)
    except export.PdfUnavailable as exc:
        raise HTTPException(501, str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, str(exc))
    name = f"{export.safe_name(job.meta.get('title') or '', job_id)} - {export.CHIP_LABELS[chip]}.pdf"
    return FileResponse(path, media_type="application/pdf", filename=name,
                        background=BackgroundTask(shutil.rmtree, path.parent, True))


@app.get("/api/config")
def get_config():
    cfg = config.load()
    try:
        import playwright  # noqa: F401
        pdf = True
    except ImportError:
        pdf = False
    return {**cfg, "detectedDrives": config.detect_google_drive(), "pdfAvailable": pdf}


@app.put("/api/config")
def put_config(body: dict):
    d = body.get("exportDir")
    if d:
        p = Path(str(d)).expanduser()
        if not p.is_dir():
            raise HTTPException(400, f"搵唔到資料夾：{p}")
        body["exportDir"] = str(p)
    return config.save(body)


def _load_any(path):
    """Load an audio file (wav or mp3); falls back to ffmpeg decoding."""
    import audio_utils as au
    try:
        return au.load(Path(path))
    except Exception:
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix="jappou_")) / "x.wav"
        au.to_wav(Path(path), tmp, sr=22050, channels=1)
        y, sr = au.load(tmp)
        shutil.rmtree(tmp.parent, ignore_errors=True)
        return y, sr


@app.get("/api/jobs/{job_id}/chords")
def job_chords(job_id: str):
    """Chord chart; computed once from the saved stems for songs analysed before chords existed."""
    job = _job(job_id)
    p = job.folder / "chords.json"
    if p.exists():
        return FileResponse(p, headers={"Cache-Control": "no-store"})
    if job.meta.get("status") != "done":
        raise HTTPException(409, "未分析完")
    import chords as chordmod
    stems = {n: job.folder / "stems" / f"{n}.mp3" for n in ("guitar", "piano", "other", "bass")}
    timing = json.loads((job.folder / "timing.json").read_text("utf-8"))
    with _lock:
        if not p.exists():
            ch = chordmod.run_for_job(job.folder, {k: v for k, v in stems.items() if v.exists()}, timing, _load_any)
            data = {"key": chordmod.key_name(ch) if ch else "", "chords": ch}
            p.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
            job.set(key=data["key"])
            if ch and (job.folder / "beats_raw.json").exists():
                pipeline.rebuild_score(job)  # split notes at the new chord changes
    return FileResponse(p, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- score editing
class EditBody(BaseModel):
    target: str            # drums | vocals | guitar | bass | other | piano | chords
    t0: float              # replace everything that starts in [t0, t1)
    t1: float
    events: list[dict] = []


@app.put("/api/jobs/{job_id}/edit")
def edit_range(job_id: str, body: EditBody):
    import editing
    job = _job(job_id)
    if job.meta.get("status") != "done":
        raise HTTPException(409, "未分析完")
    try:
        with _lock:
            job = editing.apply_edit(job, body.target, body.t0, body.t1, body.events)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    _maybe_reexport(job)
    return job.meta


@app.post("/api/jobs/{job_id}/undo")
def undo_edit(job_id: str):
    import editing
    job = _job(job_id)
    with _lock:
        res = editing.undo(job)
    if res is None:
        raise HTTPException(404, "冇嘢可以還原")
    _maybe_reexport(res[0])
    return {**res[0].meta, "undoLeft": res[1]}


@app.get("/api/jobs/{job_id}/file/{name}")
def job_file(job_id: str, name: str):
    job = _job(job_id)
    allowed = {"score.gp5", "timing.json", "lyrics.json", "drums.json", "notes.json", "chords.json"}
    if name not in allowed:
        raise HTTPException(404)
    p = job.folder / name
    if name in ("score.gp5", "timing.json") and job.meta.get("status") == "done":
        _upgrade_score(job)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "no-store"})


def _upgrade_score(job: pipeline.Job):
    """Songs analysed by an older version: rebuild score.gp5 with the current writer
    (no re-analysis needed - it only uses the saved notes / beats)."""
    from score import SCORE_FORMAT
    if int(job.meta.get("scoreFormat", 1)) >= SCORE_FORMAT or not (job.folder / "beats_raw.json").exists():
        return
    with _lock:
        job = pipeline.Job(job.folder)  # re-read inside the lock
        if int(job.meta.get("scoreFormat", 1)) < SCORE_FORMAT:
            print(f"[score] upgrading {job.meta.get('id')} to format {SCORE_FORMAT}")
            pipeline.rebuild_score(job)


@app.get("/api/jobs/{job_id}/stem/{name}.mp3")
def job_stem(job_id: str, name: str):
    job = _job(job_id)
    if name not in ("drums", "bass", "other", "vocals", "guitar", "piano"):
        raise HTTPException(404)
    p = job.folder / "stems" / f"{name}.mp3"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="audio/mpeg")


@app.get("/api/system")
def system():
    info = {"device": pipeline.device_name(), "queue": work_q.qsize(), "platform": sys.platform}
    try:
        import torch
        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            info["gpu"] = p.name
            info["vram"] = round(p.total_memory / 1024 ** 3, 1)
        elif info["device"] == "mps":
            info["gpu"] = "Apple Silicon GPU"
    except Exception:
        pass
    return info


@app.exception_handler(HTTPException)
async def http_error(_req, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


# re-queue jobs that were interrupted by a restart
for _f in DATA.iterdir():
    _m = _f / "meta.json"
    if _m.exists():
        try:
            _meta = json.loads(_m.read_text("utf-8"))
            if _meta.get("status") in ("queued", "running"):
                work_q.put(_meta["id"])
        except Exception:
            pass

app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")


class _QuietDisconnects(logging.Filter):
    """Windows logs a scary ConnectionResetError every time the browser drops an
    audio range request (seeking, switching songs). It's harmless - hide it."""

    def filter(self, record: logging.LogRecord) -> bool:
        exc = record.exc_info[1] if record.exc_info else None
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return False
        return "_call_connection_lost" not in record.getMessage()


if __name__ == "__main__":
    import uvicorn
    logging.getLogger("asyncio").addFilter(_QuietDisconnects())
    url = f"http://localhost:{PORT}"
    print(f"\n  執譜機 running at {url}\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
