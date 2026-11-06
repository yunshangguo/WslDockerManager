# WslDockerManager - one-click status check (run as Administrator, optional).
# Tells you at a glance whether the backend is up, which build is live, whether
# dockerd (127.0.0.1:2375) is reachable, and whether the WSL side is healthy.
$ErrorActionPreference = 'SilentlyContinue'
$port = 5050
$coordPort = 5051

Write-Host "=== WslDockerManager status ==="

$c = Get-NetTCPConnection -LocalPort $port -State Listen
Write-Host ("Backend (5050):    " + $(if ($c) { "LISTENING" } else { "NOT listening" }))
$coord = Get-NetTCPConnection -LocalPort $coordPort -State Listen
Write-Host ("Supervisor (5051): " + $(if ($coord) { "LISTENING" } else { "NOT listening (backend won't auto-respawn)" }))

try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 5
  $b = $r.Content | ConvertFrom-Json
  Write-Host ("Build:               " + $b.build)
  Write-Host ("Docker reachable:    " + $b.dockerReachable)
} catch {
  Write-Host ("/api/health:         unreachable (" + $_.Exception.Message + ")")
}

try {
  $wsl = wsl -d Debian -u root bash -c "systemctl is-active docker 2>/dev/null; pgrep -x dockerd >/dev/null && echo dockerd-running || echo dockerd-stopped" 2>&1
  Write-Host ("WSL Debian docker:   " + ($wsl -join ' '))
} catch {
  Write-Host ("WSL query:           failed (" + $_.Exception.Message + ")")
}

Write-Host ""
if (-not $c) {
  Write-Host "Backend is down -> run:  D:\WslDockerManager\restart-backend.bat"
} elseif ($b.dockerReachable -ne $true) {
  Write-Host "Backend is up but dockerd NOT reachable -> the backend should auto-recover; if it stays down, run restart-backend.bat or:"
  Write-Host "   wsl -d Debian -u root systemctl start docker"
} else {
  Write-Host "All green. If the UI still shows ECONNREFUSED, hard-refresh the browser (Ctrl+F5)."
}
