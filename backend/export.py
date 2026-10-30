"""PDF rendering (headless browser + the app's print.html page) and export of a
finished song into a folder — typically the Google Drive for desktop folder, so
it shows up in Google Drive on the phone/iPad."""
from __future__ import annotations

import json
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path

CHIP_LABELS = {"drums": "鼓", "vocals": "人聲旋律", "guitar": "結他", "bass": "Bass", "piano": "琴", "other": "其他"}
CHIP_TRACKS = {"drums": ["drums"], "vocals": ["vocals"], "guitar": ["guitar"], "bass": ["bass"],
               "piano": ["piano_rh", "piano_lh"], "other": ["other"]}
STEM_LABELS = {"drums": "鼓", "vocals": "人聲", "guitar": "結他", "bass": "Bass", "piano": "琴", "other": "其他"}

_browser_lock = threading.Lock()


class PdfUnavailable(RuntimeError):
    pass


def available_chips(meta: dict) -> list[str]:
    keys = {t["key"] for t in meta.get("tracks") or []}
    return [c for c, tr in CHIP_TRACKS.items() if any(t in keys for t in tr)]


def safe_name(s: str, fallback: str = "untitled") -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", s or "").strip().strip(".")
    s = re.sub(r"\s+", " ", s)
    return s[:80] or fallback


def _launch(p):
    """Bundled Chromium first, then the system Edge / Chrome (no download needed)."""
    errors = []
    for kw in ({}, {"channel": "msedge"}, {"channel": "chrome"}):
        try:
            return p.chromium.launch(**kw)
        except Exception as exc:  # noqa: BLE001
            errors.append(str(exc).splitlines()[0])
    raise PdfUnavailable("搵唔到可以用嚟出 PDF 嘅瀏覽器：" + " | ".join(errors))


def render_pdfs(base_url: str, job_id: str, requests: list[dict]) -> None:
    """requests: [{chip, out, lyrics, bars, stave}] -> writes each PDF to `out`."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise PdfUnavailable("未裝 playwright（重新執行安裝程式）") from exc
    with _browser_lock, sync_playwright() as p:
        browser = _launch(p)
        try:
            page = browser.new_page(viewport={"width": 900, "height": 1200})
            for r in requests:
                url = (f"{base_url}/print.html?id={job_id}&chip={r['chip']}&lyrics={r.get('lyrics', 'line')}"
                       f"&bars={r.get('bars', 4)}&stave={r.get('stave', 'auto')}&t={time.time():.0f}")
                page.goto(url, wait_until="load")
                page.wait_for_function("window.__printReady === true || !!window.__printError", timeout=180_000)
                err = page.evaluate("window.__printError || null")
                if err:
                    raise RuntimeError(f"PDF（{r['chip']}）失敗：{err}")
                page.emulate_media(media="print")
                Path(r["out"]).parent.mkdir(parents=True, exist_ok=True)
                page.pdf(path=str(r["out"]), format="A4", print_background=True, prefer_css_page_size=True)
        finally:
            browser.close()


def render_single_pdf(base_url: str, job_id: str, chip: str, lyrics: str, bars: int, stave: str) -> Path:
    out = Path(tempfile.mkdtemp(prefix="jappou_")) / f"{chip}.pdf"
    render_pdfs(base_url, job_id, [{"chip": chip, "out": out, "lyrics": lyrics, "bars": bars, "stave": stave}])
    return out


def export_job(job, cfg: dict, base_url: str, log=print) -> Path:
    """Write PDFs (+ stems, lyrics, GP5) into <exportDir>/執譜機/<title>/."""
    meta = job.meta
    root = Path(cfg.get("exportDir") or "").expanduser()
    if not str(root) or not root.exists():
        raise RuntimeError(f"匯出資料夾唔存在：{root}")
    title = safe_name(meta.get("title") or "", meta["id"])
    dest = root / "執譜機" / title
    old = Path((meta.get("exported") or {}).get("dir") or "")
    if str(old) and old != dest and old.exists() and not dest.exists() and old.parent == dest.parent:
        old.rename(dest)  # song was renamed: move the old export instead of duplicating it
        for f in dest.glob("*"):
            if f.is_file() and not f.name.startswith(title):
                f.unlink()  # old-title PDFs/LRC/GP5 get rewritten below
    dest.mkdir(parents=True, exist_ok=True)

    chips = available_chips(meta)
    if cfg.get("exportInstruments") == "drums":
        chips = [c for c in chips if c == "drums"] or chips[:1]
    tmp = Path(tempfile.mkdtemp(prefix="jappou_export_"))
    try:
        reqs = [{"chip": c, "out": tmp / f"{title} - {CHIP_LABELS[c]}.pdf",
                 "lyrics": cfg.get("pdfLyrics", "line"), "bars": cfg.get("pdfBars", 4)} for c in chips]
        render_pdfs(base_url, meta["id"], reqs)
        for r in reqs:  # write to a temp dir first so Drive never syncs half-written files
            shutil.copy2(r["out"], dest / Path(r["out"]).name)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if cfg.get("exportStems", True):
        sd = dest / "音軌"
        sd.mkdir(exist_ok=True)
        for f in (job.folder / "stems").glob("*.mp3"):
            target = sd / f"{STEM_LABELS.get(f.stem, f.stem)}.mp3"
            if not target.exists() or target.stat().st_size != f.stat().st_size:
                shutil.copy2(f, target)

    ly = job.folder / "lyrics.json"
    if ly.exists():
        lines = json.loads(ly.read_text("utf-8")).get("lines", [])
        if lines:
            txt = "\n".join(f"[{int(l['start'] // 60):02d}:{l['start'] % 60:05.2f}]{l['text']}" for l in lines)
            (dest / f"{title} - 歌詞.lrc").write_text(txt + "\n", "utf-8")
    sheet = chord_sheet(job.folder, meta)
    if sheet:
        (dest / f"{title} - 和弦.txt").write_text(sheet, "utf-8")
    gp = job.folder / "score.gp5"
    if gp.exists():
        shutil.copy2(gp, dest / f"{title}.gp5")

    job.set(exported={"dir": str(dest), "time": time.time()})
    log(f"已匯出去 {dest}")
    return dest


def chord_sheet(folder: Path, meta: dict) -> str:
    """Plain-text chord chart, 4 bars per line:  | Eb . . . | Abmaj7 . Bb . |"""
    cp, tp = folder / "chords.json", folder / "timing.json"
    if not cp.exists() or not tp.exists():
        return ""
    data = json.loads(cp.read_text("utf-8"))
    chords = data.get("chords", [])
    timing = json.loads(tp.read_text("utf-8"))
    if not chords:
        return ""
    n = timing["beatsPerBar"]
    beats = timing["beats"]
    bars = []
    prev = None
    for b in range(timing["nBars"]):
        cells = []
        for i in range(n):
            k = b * n + i
            if k >= len(beats):
                break
            t = beats[k]["time"] + 0.01
            c = next((c["name"] for c in chords if c["start"] <= t < c["end"]), "")
            cells.append(c if c and c != prev else ".")
            prev = c or prev
        bars.append(" ".join(cells))
    lines = [f"{meta.get('title', '')} - {meta.get('artist', '')}",
             f"調：{data.get('key', '')}　BPM：{round(timing.get('bpm', 0))}　拍號：{n}/4", ""]
    for i in range(0, len(bars), 4):
        lines.append(f"{i + 1:>3}  | " + " | ".join(f"{x:<16}" for x in bars[i:i + 4]) + " |")
    return "\n".join(lines) + "\n"
