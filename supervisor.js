// WslDockerManager - supervisor (Stage 1).
// Single-instance guard: only the process that successfully binds the coordinator
// port (5051) is the leader and manages the server child. This mirrors the
// NasManager pattern so two supervisors never fight over the server.
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const log = require('./src/logger');

// Self-elevate to Windows administrator on startup so the project always runs with
// host-admin rights (required for Register-ScheduledTask / WSL install / etc.).
// Only acts when this file is the entry point (not when required by another module).
if (require.main === module) {
  try { require('./src/elevate').ensureElevated(); } catch (e) { /* ignore */ }
}

const COORD_PORT = cfg.coordinatorPort;
const HEALTH_URL = `http://127.0.0.1:${cfg.port}/api/health`;

const server = net.createServer();
server.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.warn(`coordinator port ${COORD_PORT} already held - another supervisor is leader. Exiting.`);
    process.exit(0);
  }
  throw err;
});

server.listen(COORD_PORT, () => {
  log.info(`supervisor leader bound coordinator port ${COORD_PORT}`);
  start();
});

let child = null;
let restartTimer = null;
let failures = 0;

function start() {
  log.info('starting server child...');
  child = spawn(process.execPath, [path.join(cfg.rootDir, 'server.js')], {
    cwd: cfg.rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', (d) => fs.appendFileSync(cfg.logFileAbs, d));
  child.stderr.on('data', (d) => fs.appendFileSync(cfg.logFileAbs, d));
  child.on('exit', (code, signal) => {
    log.warn(`server exited (code=${code} signal=${signal}); restarting in 1s`);
    child = null;
    restartTimer = setTimeout(start, 1000);
  });
}

// periodic health check: 2 consecutive failures -> SIGKILL + restart
setInterval(() => {
  if (!child) return;
  const req = require('http').get(HEALTH_URL, (res) => {
    res.resume();
    if (res.statusCode === 200) failures = 0;
    else failures++;
    if (failures >= 3) killAndRestart();
  });
  req.on('error', () => {
    failures++;
    if (failures >= 3) killAndRestart();
  });
  req.setTimeout(8000, () => {
    req.destroy();
    failures++;
    if (failures >= 3) killAndRestart();
  });
}, 15000);

function killAndRestart() {
  log.warn('health check failed 2x - killing server child');
  failures = 0;
  if (child) {
    try { child.kill('SIGKILL'); } catch (e) {}
  }
}

process.on('exit', () => {
  if (child) try { child.kill(); } catch (e) {}
});
