@echo off
cd /d "%~dp0"
title Jap Pou Gei
if not exist ".venv\Scripts\python.exe" (
  echo Please run install.bat first.
  pause
  exit /b 1
)
call ".venv\Scripts\activate.bat"
echo Starting... the app opens at http://localhost:8765
echo Keep this window open while you use the app. Close it to stop.
python backend\app.py
pause
