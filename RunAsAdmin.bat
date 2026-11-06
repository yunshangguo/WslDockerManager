@echo off
REM ================================================================
REM  WslDockerManager - start backend as Windows ADMINISTRATOR
REM  ----------------------------------------------------------------
REM  Right-click this file -> "Run as administrator" (most reliable).
REM  Approve the UAC prompt. The backend will then run with host
REM  administrator rights, so "create keep-alive task" / "one-click
REM  install" no longer fail or prompt for UAC.
REM ================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\WslDockerManager\restart-backend.ps1"
