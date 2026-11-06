// src/elevate.js
// Make the WslDockerManager backend default to running as a Windows administrator.
//
// A running process cannot grant itself admin rights, so the only way to "default
// to admin" is to relaunch an elevated copy of ourselves at startup. supervisor.js
// (the persistent entry that forks server.js) calls ensureElevated() as its very
// first action:
//   - if already admin  -> do nothing
//   - if not admin      -> write a small ASCII bootstrap PS1, launch it with
//                          `Start-Process -Verb RunAs` (UAC prompt), then exit.
//                          The elevated bootstrap kills any stale supervisor/server
//                          for this project and starts a fresh elevated copy that
//                          carries the `--elevated` marker (so it will NOT loop).
//
// Result: launching the backend by ANY method (double-click bat, script, scheduled
// task, or the Electron shell) ends up running as Windows admin, with no manual
// "Run as administrator" right-click required.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function isAdmin() {
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))'
    ], { timeout: 15000, windowsHide: true });
    return /true/i.test(out.toString());
  } catch (e) {
    return false;
  }
}

function ensureElevated() {
  if (process.platform !== 'win32') return;
  if (isAdmin()) return;

  // Already attempted elevation (e.g. the OS denied the UAC prompt) -> run as-is.
  if (process.argv.includes('--elevated')) {
    try {
      fs.appendFileSync(
        path.join(__dirname, '..', 'elevate.log'),
        `[${new Date().toISOString()}] warning: running without administrator rights (elevation was not effective)\n`
      );
    } catch (_) {}
    return;
  }

  const rootDir = path.join(__dirname, '..');
  const nodeExe = process.execPath;
  const script = process.argv[1];
  const cwd = process.cwd();

  // ASCII-only bootstrap (no Chinese -> no UTF-8 BOM needed, avoids the classic
  // PowerShell GBK mis-parse). It runs elevated, so the Start-Process below
  // inherits admin and the new supervisor is also admin.
  const bootstrap = [
    '$ErrorActionPreference="Stop"',
    `$root='${rootDir.replace(/'/g, "''")}'`,
    `$nodeExe='${nodeExe.replace(/'/g, "''")}'`,
    `$script='${script.replace(/'/g, "''")}'`,
    `$cwd='${cwd.replace(/'/g, "''")}'`,
    "$args=@($script,'--elevated')",
    "$procs=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
    "foreach ($p in $procs) {",
    "  if ($p.CommandLine -and $p.CommandLine -like \"*$root*\" -and ($p.CommandLine -like '*supervisor.js*' -or $p.CommandLine -like '*server.js*')) {",
    "    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}",
    "  }",
    "}",
    "Start-Sleep -Seconds 1",
    "Start-Process -FilePath $nodeExe -ArgumentList $args -WorkingDirectory $cwd"
  ].join('\r\n');

  const bootstrapPath = path.join(rootDir, 'install', '_elevate_bootstrap.ps1');
  fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
  fs.writeFileSync(bootstrapPath, bootstrap, { encoding: 'utf8' });

  try {
    spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive',
      '-Command', `Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${bootstrapPath.replace(/'/g, "''")}')`
    ], { windowsHide: true, stdio: 'ignore' });
  } catch (e) { /* ignore - next launch will retry */ }

  process.exit(0);
}

module.exports = { isAdmin, ensureElevated };
