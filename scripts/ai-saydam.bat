@echo off
chcp 65001 >nul
if "%~1"=="" (
  echo.
  echo   KANKA CHAT - AI SAYDAM VIDEO / GORSEL DONUSTURUCU
  echo   Kullanim: Herhangi bir .mp4 / .mov / .png dosyasini bu .bat dosyasinin ustune surukleyip birakin!
  echo.
  pause
  exit /b 1
)
set "PY=C:\Users\pisago\.gemini\antigravity\scratch\kanka-ai-venv\Scripts\python.exe"
"%PY%" "%~dp0ai-saydam.py" "%~1"
echo.
pause
