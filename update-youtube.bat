@echo off
cd /d "%~dp0"
REM YouTube changes often - if downloads start failing, run this to update yt-dlp.
call ".venv\Scripts\activate.bat"
pip install -U "yt-dlp[default]"
echo.
echo yt-dlp updated.
pause
