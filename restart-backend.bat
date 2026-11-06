@echo off
REM WslDockerManager - one-click backend restart.
REM Must be run AS ADMINISTRATOR (right-click -> Run as administrator),
REM otherwise the old server process cannot be killed and you keep getting 404.
chcp 65001 >nul
setlocal
set "PORT=5050"

net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Please run this file as Administrator:
  echo          right-click restart-backend.bat -> "Run as administrator".
  echo          Without admin rights the old server cannot be killed, so the 404 persists.
  pause
  exit /b 1
)

echo Restarting WslDockerManager backend...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-backend.ps1"
pause
