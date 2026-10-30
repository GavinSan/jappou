#!/bin/bash
# 執譜機 - one-time setup for macOS (double-click in Finder, or: bash install.command)
cd "$(dirname "$0")" || exit 1
set -o pipefail

echo
echo "============================================================"
echo "  Jap Pou Gei - one-time setup (macOS)"
echo "  Downloads about 3-5 GB (PyTorch + AI models)."
echo "============================================================"
echo

fail() { echo; echo "  Installation failed: $1"; echo "  Scroll up to see the error."; read -r -p "Press Enter to close..."; exit 1; }

# ---------- 1. Python 3.11 ------------------------------------------------
PY=""
for c in python3.11 /opt/homebrew/bin/python3.11 /usr/local/bin/python3.11 /Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "[1/5] Installing Python 3.11 with Homebrew..."
    brew install python@3.11 || fail "brew install python@3.11"
    PY="$(brew --prefix)/bin/python3.11"
  else
    echo "[1/5] Python 3.11 not found."
    echo "      Install it from https://www.python.org/downloads/macos/ (pick a 3.11.x 'macOS 64-bit universal2 installer'),"
    echo "      then run install.command again."
    open "https://www.python.org/downloads/macos/" 2>/dev/null
    read -r -p "Press Enter to close..."
    exit 1
  fi
else
  echo "[1/5] Using $PY"
fi

# ---------- 2. virtual environment -----------------------------------------
if [ ! -x ".venv/bin/python" ]; then
  echo "[2/5] Creating virtual environment..."
  "$PY" -m venv .venv || fail "venv"
fi
source .venv/bin/activate || fail "activate venv"
python -m pip install --upgrade pip wheel setuptools || fail "pip upgrade"

# ---------- 3. PyTorch (Apple Silicon GPU support is built in) -------------
echo "[3/5] Installing PyTorch..."
pip install torch==2.7.1 torchaudio==2.7.1 || fail "torch"

# ---------- 4. everything else ---------------------------------------------
echo "[4/5] Installing audio / AI packages..."
pip install -r requirements.txt || fail "requirements"
echo "      Setting up PDF export (headless browser)..."
python -m playwright install chromium || echo "  Note: Chromium download failed - PDF export will try Google Chrome instead."
echo "      Installing Basic Pitch (guitar / bass / piano transcription)..."
# --no-deps: skip TensorFlow / CoreML; we run Basic Pitch's ONNX model
if ! pip install --no-deps basic-pitch; then
  echo
  echo "  WARNING: basic-pitch failed to install. Drums and lyrics still work,"
  echo "  but guitar / bass / piano / vocal-melody scores will be skipped."
  echo
fi
pip uninstall -y tensorflow tensorflow-macos >/dev/null 2>&1

# ---------- 5. JS runtime for yt-dlp (YouTube) -----------------------------
if command -v deno >/dev/null 2>&1 || command -v node >/dev/null 2>&1; then
  echo "[5/5] JavaScript runtime found."
elif command -v brew >/dev/null 2>&1; then
  echo "[5/5] Installing Deno (yt-dlp needs it for YouTube)..."
  brew install deno || echo "  Note: could not install Deno; YouTube downloads may fail - use MP3 upload instead."
else
  echo "[5/5] Installing Deno (yt-dlp needs it for YouTube)..."
  curl -fsSL https://deno.land/install.sh | sh -s -- -y || echo "  Note: could not install Deno."
fi

chmod +x run.command update-youtube.command 2>/dev/null
echo
python -c "import torch, platform; print('PyTorch', torch.__version__, '|', platform.machine(), '| Apple GPU (MPS):', torch.backends.mps.is_available())"
echo
echo "============================================================"
echo "  Done! Double-click run.command to start."
echo "  (The first song also downloads the AI models, ~2-3 GB.)"
echo "============================================================"
read -r -p "Press Enter to close..."
