# WslDockerManager backend restart core logic.
# Goal: start the backend (supervisor -> server) as a real WINDOWS ADMINISTRATOR,
# so "create keep-alive task" / "one-click install" no longer fail on permissions.
#
# Most reliable usage:
#   Right-click RunAsAdmin.bat (or this file) -> "Run as administrator", then allow UAC.
# This script also self-elevates: if launched as a normal user it re-launches itself
# elevated via UAC (approve the prompt).

$scriptPath = $MyInvocation.MyCommand.Path

function Test-IsAdmin {
  return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Self-elevate if needed.
if (-not (Test-IsAdmin)) {
  Write-Host "WslDockerManager backend needs Windows Administrator rights."
  Write-Host "Requesting elevation - please click YES on the UAC prompt..."
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath)
  Read-Host "Elevation requested. If you approved the UAC, the backend will restart as administrator. Press Enter to close this window"
  exit
}

# From here we are running as a Windows Administrator.
$port = 5050
$coordPort = 5051
$root = $PSScriptRoot
$supLog = Join-Path $root 'wsl-docker-supervisor.log'
$supErrLog = Join-Path $root 'wsl-docker-supervisor.err.log'

# Resolve node.exe (elevated sessions may have a trimmed PATH).
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  $candidates = @('C:\Program Files\nodejs\node.exe','C:\Program Files (x86)\nodejs\node.exe')
  foreach ($c in $candidates) { if (Test-Path $c) { $nodeExe = $c; break } }
}
if (-not $nodeExe) {
  try { $nodeExe = (where.exe node 2>$null | Select-Object -First 1) } catch {}
}
if (-not $nodeExe) { $nodeExe = 'node' }
Write-Host ("Using node: " + $nodeExe)

function Kill-ByPort($p) {
  $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($conns) {
    $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
      try { Stop-Process -Id $_ -Force -ErrorAction Stop; Write-Host ("  killed PID=" + $_ + " on port " + $p) } catch { Write-Host ("  failed to kill PID=" + $_ + ": " + $_.Exception.Message) }
    }
  }
}

Write-Host ("[1/5] Killing anything on port " + $port + " (old server.js)...")
Kill-ByPort $port

Write-Host ("[2/5] Killing the supervisor/coordinator on port " + $coordPort + " (stale non-admin supervisor)...")
Kill-ByPort $coordPort
# Also kill by command line to be safe (elevated PowerShell can read command lines).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*supervisor.js*' } | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Host ("  killed supervisor PID=" + $_.ProcessId) } catch { Write-Host ("  failed to kill supervisor PID=" + $_.ProcessId) }
}

# Wait until coordinator port is actually free before launching a new supervisor.
Write-Host ("[3/5] Waiting for coordinator port " + $coordPort + " to be free...")
$free = $false
for ($i = 0; $i -lt 15; $i++) {
  $c = Get-NetTCPConnection -LocalPort $coordPort -State Listen -ErrorAction SilentlyContinue
  if (-not $c) { $free = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $free) { Write-Host ("  WARNING: port " + $coordPort + " still busy after 15s; new supervisor may fail to bind (EADDRINUSE).") }
else { Write-Host ("  coordinator port is free.") }

function Start-Supervisor {
  Start-Process -FilePath $nodeExe -ArgumentList 'supervisor.js' `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $supLog -RedirectStandardError $supErrLog -ErrorAction Stop
}

Write-Host ("[4/5] Launching supervisor (ELEVATED) so the backend inherits administrator rights...")
try { Start-Supervisor; Write-Host ("  supervisor launched (logs: " + $supLog + " / " + $supErrLog + ")") }
catch { Write-Host ("  Failed to launch supervisor: " + $_.Exception.Message) }

Write-Host ("[5/5] Waiting for backend (port " + $port + ") to come back up (up to 25s)...")
$ok = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 1
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($c) { $ok = $true; break }
}
if ($ok) { Write-Host ("  Backend is listening on " + $port + " (running as Administrator).") }
else { Write-Host ("  Backend did not come up in 25s. Check " + $supLog + " / " + $supErrLog) }

# Verification file the user can open to confirm admin status.
$verify = "WslDockerManager backend restart result`nTime: $(Get-Date)`nWindowsAdministrator: YES (this script ran elevated)`nThe backend should now run with Windows administrator rights.`nOpen http://localhost:5050 -> Environment page; the Windows host admin status should read YES."
$verify | Out-File -FilePath (Join-Path $root 'admin-status.txt') -Encoding utf8

Write-Host "Done. Open http://localhost:5050 -> Environment page; Windows host admin status should now be YES."
Read-Host "Press Enter to close"
