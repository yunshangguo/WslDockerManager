@echo off
REM ================================================================
REM  Create the WslDockerKeepAlive scheduled task as Windows ADMIN.
REM  This is INDEPENDENT of the backend's admin status - it runs the
REM  installer script directly with administrator rights.
REM  ----------------------------------------------------------------
REM  Usage: right-click this file -> "Run as administrator"
REM         (or double-click - it will self-elevate via UAC).
REM ================================================================
NET SESSION >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator rights ...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo Running as administrator - creating WslDockerKeepAlive scheduled task ...
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\WslDockerManager\install\create-keepalive.ps1"

echo.
echo Done. The WslDockerKeepAlive scheduled task should now exist.
echo Verify in Task Scheduler (taskschd.msc) or re-check the Environment page.
pause
