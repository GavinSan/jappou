"""User settings (export folder etc.) stored in data/config.json."""
from __future__ import annotations

import json
import os
import string
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("JAPPOU_DATA", ROOT / "data"))
CONFIG_PATH = DATA_DIR / "config.json"

DEFAULTS = {
    "exportDir": "",            # e.g. G:\My Drive  or  ~/Library/CloudStorage/GoogleDrive-x/My Drive
    "autoExport": True,         # export to the folder when an analysis finishes / after edits
    "exportStems": True,        # copy the separated mp3 stems too
    "exportInstruments": "all",  # "all" | "drums"
    "pdfLyrics": "line",        # line | word | off
    "pdfBars": 4,
    "whisperModel": "auto",
}

_lock = threading.Lock()


def load() -> dict:
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text("utf-8")))
    except Exception:
        pass
    return cfg


def save(update: dict) -> dict:
    with _lock:
        cfg = load()
        for k, v in update.items():
            if k in DEFAULTS:
                cfg[k] = v
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), "utf-8")
        return cfg


MY_DRIVE_NAMES = ["My Drive", "我的雲端硬碟", "我的云端硬盘", "マイドライブ", "내 드라이브"]


def detect_google_drive() -> list[str]:
    """Find 'My Drive' folders created by Google Drive for desktop."""
    found: list[Path] = []
    home = Path.home()
    if sys.platform == "darwin":
        cs = home / "Library" / "CloudStorage"
        if cs.exists():
            for acct in sorted(cs.glob("GoogleDrive-*")):
                for n in MY_DRIVE_NAMES:
                    if (acct / n).is_dir():
                        found.append(acct / n)
        for n in MY_DRIVE_NAMES:  # older "Backup and Sync" style
            if (home / "Google Drive" / n).is_dir():
                found.append(home / "Google Drive" / n)
        if (home / "Google Drive").is_dir() and not found:
            found.append(home / "Google Drive")
    elif os.name == "nt":
        for letter in string.ascii_uppercase[2:]:  # skip A:/B:
            root = Path(f"{letter}:\\")
            for n in MY_DRIVE_NAMES:
                try:
                    if (root / n).is_dir():
                        found.append(root / n)
                except OSError:
                    pass
        for n in MY_DRIVE_NAMES:
            if (home / "Google Drive" / n).is_dir():
                found.append(home / "Google Drive" / n)
    else:
        for n in MY_DRIVE_NAMES:
            if (home / "Google Drive" / n).is_dir():
                found.append(home / "Google Drive" / n)
    seen, out = set(), []
    for p in found:
        s = str(p)
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out
