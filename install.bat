@echo off
setlocal
cd /d "%~dp0"
title Jap Pou Gei - install

echo.
echo ============================================================
echo   Jap Pou Gei - one-time setup
echo   This downloads about 4-6 GB (PyTorch + AI models).
echo ============================================================
echo.

REM ---------- 1. Python 3.11 --------------------------------------------
py -3.11 --version >nul 2>nul
if errorlevel 1 (
  echo [1/5] Python 3.11 not found. Installing it with winget...
  winget install -e --id Python.Python.3.11 --accept-source-agreements --accept-package-agreements
  py -3.11 --version >nul 2>nul
  if errorlevel 1 (
    echo.
    echo Python was installed. Please CLOSE this window and run install.bat again.
    echo If winget is not available, install Python 3.11 from https://www.python.org/downloads/
    echo and tick "Add python.exe to PATH" during setup.
    pause
    exit /b 1
  )
) else (
  echo [1/5] Python 3.11 found.
)

REM ---------- 2. virtual environment ------------------------------------
if not exist ".venv\Scripts\python.exe" (
  echo [2/5] Creating virtual environment...
  py -3.11 -m venv .venv || goto :fail
) else (
  echo [2/5] Virtual environment exists.
)
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip wheel setuptools || goto :fail

REM ---------- 3. PyTorch (CUDA if an NVIDIA card is present) ------------
nvidia-smi >nul 2>nul
if errorlevel 1 (
  echo [3/5] No NVIDIA GPU detected - installing CPU PyTorch ^(analysis will be slow^).
  pip install torch==2.7.1 torchaudio==2.7.1 || goto :fail
) else (
  echo [3/5] NVIDIA GPU detected - installing CUDA PyTorch...
  pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu128 || goto :fail
)

REM ---------- 4. everything else -----------------------------------------
echo [4/5] Installing audio / AI packages...
pip install -r requirements.txt || goto :fail
echo        Setting up PDF export ^(headless browser^)...
python -m playwright install chromium
if errorlevel 1 echo   Note: Chromium download failed - PDF export will use Microsoft Edge instead.
echo        Installing Basic Pitch ^(guitar / bass / piano transcription^)...
REM  --no-deps: skip TensorFlow (its model loading breaks on Windows); we use the ONNX model
pip install --no-deps basic-pitch
if errorlevel 1 (
  echo.
  echo   WARNING: basic-pitch failed to install. Drums and lyrics will still work,
  echo   but guitar / bass / piano / vocal-melody scores will be skipped.
  echo.
)
pip uninstall -y tensorflow tensorflow-intel >nul 2>nul

REM ---------- 5. JavaScript runtime for yt-dlp (YouTube) -----------------
where deno >nul 2>nul
if errorlevel 1 (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [5/5] Installing Deno ^(yt-dlp needs a JS runtime for YouTube^)...
    winget install -e --id DenoLand.Deno --accept-source-agreements --accept-package-agreements
  ) else (
    echo [5/5] Node.js found - yt-dlp can use it.
  )
) else (
  echo [5/5] Deno found.
)

echo.
python -c "import torch; print('PyTorch', torch.__version__, '| CUDA available:', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
echo.
echo ============================================================
echo   Done! Double-click run.bat to start.
echo   (The first song will also download the AI models, ~3 GB.)
echo ============================================================
pause
exit /b 0

:fail
echo.
echo   Installation failed - scroll up to see the error.
pause
exit /b 1
