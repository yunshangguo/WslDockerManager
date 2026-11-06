@echo off
REM WslDockerManager launcher: starts the supervisor elevated (one UAC prompt) so the
REM backend process inherits admin; afterwards "create keep-alive task" / "install wizard"
REM no longer pop UAC.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"D:\WslDockerManager\restart-backend.ps1\"'"
echo WslDockerManager requested to start as administrator (please allow the UAC prompt). Then open http://localhost:5050
echo To restart the backend later, just run this file or restart-backend.ps1 (both elevated); the supervisor respawns server.js with new code.
timeout /t 3 >nul
