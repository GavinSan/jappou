"""Spoken metronome counts ("one", "and", "e", "a" ...), made once with the
computer's own speech engine and cached as short, trimmed WAV clips:

* Windows: System.Speech via PowerShell (built in)
* macOS:   the `say` command (built in)
* Linux:   espeak-ng / espeak if installed
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

import audio_utils as au
import config

WORDS = {
    "one": "one", "two": "two", "three": "three", "four": "four", "five": "five", "six": "six", "seven": "seven",
    "and": "and", "e": "ee", "a": "ah",
}
CACHE = config.DATA_DIR / "voice"
SR = 44100


class VoiceUnavailable(RuntimeError):
    pass


def _run(args, **kw):
    flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags, timeout=30, **kw)
    if p.returncode != 0:
        raise VoiceUnavailable(p.stderr.decode("utf-8", "ignore")[-300:] or f"exit {p.returncode}")


def _speak_to_file(text: str, out: Path):
    if sys.platform == "win32":
        ps = (
            "Add-Type -AssemblyName System.Speech;"
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            "try { $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1;"
            " if ($v) { $s.SelectVoice($v.VoiceInfo.Name) } } catch {};"
            "$s.Rate = 2;"
            f"$s.SetOutputToWaveFile('{out}');"
            f"$s.Speak('{text}');"
            "$s.Dispose()"
        )
        _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps])
    elif sys.platform == "darwin":
        aiff = out.with_suffix(".aiff")
        _run(["say", "-r", "230", "-o", str(aiff), text])
        au.to_wav(aiff, out, sr=SR, channels=1)
    else:
        exe = shutil.which("espeak-ng") or shutil.which("espeak")
        if not exe:
            raise VoiceUnavailable("冇語音引擎（Linux 請裝 espeak-ng）")
        _run([exe, "-v", "en-us", "-s", "210", "-w", str(out), text])


def _trim(y: np.ndarray, sr: int) -> np.ndarray:
    """Cut silence so the word starts right on the click, normalise, short fades."""
    if y.ndim == 2:
        y = y.mean(axis=1)
    env = np.abs(y)
    thr = max(1e-4, env.max() * 0.04)
    idx = np.where(env > thr)[0]
    if len(idx) == 0:
        return y[:1]
    a = max(0, idx[0] - int(0.004 * sr))
    b = min(len(y), idx[-1] + int(0.03 * sr))
    y = y[a:b].astype(np.float32)
    y = y / (np.abs(y).max() + 1e-9) * 0.9
    fade = min(len(y) // 4, int(0.01 * sr))
    if fade > 0:
        y[-fade:] *= np.linspace(1, 0, fade)
    return y


def get(word: str) -> Path:
    if word not in WORDS:
        raise KeyError(word)
    CACHE.mkdir(parents=True, exist_ok=True)
    final = CACHE / f"{word}.wav"
    if final.exists() and final.stat().st_size > 1000:
        return final
    tmp = Path(tempfile.mkdtemp(prefix="jappou_voice_"))
    try:
        raw = tmp / "raw.wav"
        _speak_to_file(WORDS[word], raw)
        if not raw.exists():
            raise VoiceUnavailable("語音引擎冇出到聲")
        y, sr = au.load_any(raw)
        au.save_wav(final, _trim(y, sr), sr)
        return final
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
