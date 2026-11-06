@echo off
cd /d D:\WslDockerManager
if not exist node_modules (
  echo node_modules missing, installing...
  call npm install
)
echo Starting WslDockerManager supervisor (logs -> wsl-docker.log / wsl-docker-supervisor.log)
start "" node supervisor.js
echo Done. Open http://localhost:5050/api/health
pause
