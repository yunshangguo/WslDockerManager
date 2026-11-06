// WslDockerManager — Electron desktop shell.
// - forks the existing Express backend (server.js) as an isolated child process
//   using Electron's bundled Node runtime (ELECTRON_RUN_AS_NODE), so no separate
//   node.exe is required in the packaged app
// - opens a desktop window that loads the existing web UI from 127.0.0.1:<port>
// - lives in the system tray; closing the window lets the user pick
//   "minimize to tray" (backend keeps running) or "quit"
// - a settings window lets the user change the port and the admin account/password
//
// Persistence:
//   packaged  -> %APPDATA%/<app>/settings.json + %APPDATA%/<app>/data/*
//   dev       -> ./electron-settings.json + ./data/*  (same as `npm start`)
// The backend child receives WSLDM_PORT / WSLDM_DATA_DIR so src/config.js points
// every mutable path at that location.
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { fork, spawn, execFileSync } = require('child_process');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const ICON_PATH = path.join(__dirname, 'icon.png');
const SETTINGS_HTML = path.join(__dirname, 'settings.html');
const SETTINGS_PRELOAD = path.join(__dirname, 'settings-preload.js');

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let backend = null;
let isQuitting = false;
let restarting = false;
let firstRun = false;
let currentPort = 5050;

// ---------------------------------------------------------------- paths / logs
function userDataDir() {
  try { return app.getPath('userData'); } catch (_) { return ROOT; }
}
function dataDir() {
  let d = readSettings().dataDir;
  if (!d) d = defaultDataDir();
  return path.isAbsolute(d) ? d : path.resolve(d);
}
function settingsFile() {
  return app.isPackaged ? path.join(userDataDir(), 'settings.json') : path.join(ROOT, 'electron-settings.json');
}
function usersFile() {
  return path.join(dataDir(), 'secrets', 'users.json');
}
function electronLogFile() {
  return app.isPackaged ? path.join(userDataDir(), 'electron.log') : path.join(ROOT, 'wsl-docker-electron.log');
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    const f = electronLogFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, line);
  } catch (_) {}
  try { console.log(...args); } catch (_) {}
}

// ---------------------------------------------------------------- settings files
function readSettings() {
  let s = null;
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    if (raw && typeof raw === 'object') s = raw;
  } catch (e) { /* not created yet */ }
  if (!s || !s.port) {
    // Fall back to the bundled config.json port (dev convenience / first packaged run).
    try {
      const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
      s = s || {};
      if (!s.port) s.port = Number(c.port) || 5050;
    } catch (e) {}
  }
  s = s || {};
  if (!s.port) s.port = 5050;
  if (!s.dataDir) s.dataDir = defaultDataDir();
  return s;
}
function defaultDataDir() {
  return app.isPackaged ? path.join(userDataDir(), 'data') : path.join(ROOT, 'data');
}
function writeSettings(s) {
  const f = settingsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
}
function loadUsers() {
  try {
    const a = JSON.parse(fs.readFileSync(usersFile(), 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function findAdmin(users) {
  return users.find((u) => u && u.role === 'admin') || users.find((u) => u && u.username === 'admin') || null;
}
// Same scrypt scheme as src/auth.js (salt:hash hex), so the backend can verify it.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

// ---------------------------------------------------------------- backend child
// Fast readiness probe: a raw TCP connect to the backend port. We deliberately
// avoid the HTTP /api/health endpoint here because that endpoint runs
// ensureDockerd() on its first hit, which can block for many seconds while WSL +
// dockerd cold-start. A TCP connect returns the instant the server binds the
// port, so the UI window appears immediately and docker readiness is handled
// separately by the page itself.
function waitForPort(host, port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ host, port }, () => { sock.destroy(); resolve(true); });
      sock.on('error', retry);
      sock.setTimeout(1500, () => { sock.destroy(); retry(); });
      function retry() {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tryOnce, 400);
      }
    };
    tryOnce();
  });
}

// Free whatever process is currently bound to our HTTP port before we fork the
// backend. A stale backend from an EARLIER build (or a previous run that was only
// closed-to-tray) may still be holding the port and reading a DIFFERENT
// data dir; if our fresh backend hit EADDRINUSE it would crash and the stale one
// would keep serving — which is exactly what made a newly-set password fail with
// 401. Killing the occupant lets our backend own the port and the canonical
// data dir. Port 5050 is dedicated to this app, so this is safe.
function freePort(port) {
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; if ($p) { $p | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }`,
    ], { timeout: 8000, windowsHide: true });
    // give the OS a moment to release the socket
    const t = Date.now();
    while (Date.now() - t < 400) { /* busy-wait ~400ms */ }
  } catch (_) { /* best-effort; bind will surface any remaining conflict */ }
}

// Recursively copy everything from oldDir into newDir (best-effort). Used when the
// user changes the data directory so already-generated files follow to the new
// location. Open/locked files (e.g. a live audit log) are skipped rather than
// failing the whole migration.
function migrateDataDir(oldDir, newDir) {
  if (!oldDir || !newDir || oldDir === newDir) return 0;
  if (!fs.existsSync(oldDir)) return 0;
  let copied = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, e.name);
      const dst = path.join(to, e.name);
      try {
        if (e.isDirectory()) walk(src, dst);
        else { fs.copyFileSync(src, dst); copied++; }
      } catch (err) {
        log('migrate skip ' + src + ': ' + (err && err.message));
      }
    }
  };
  try { walk(oldDir, newDir); } catch (err) { log('migrate error: ' + (err && err.message)); }
  return copied;
}

function startBackend() {
  if (backend) return;
  freePort(currentPort);
  const port = Number(readSettings().port) || 5050;
  currentPort = port;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', WSLDM_PORT: String(port), WSLDM_DATA_DIR: dataDir() };
  if (process.env.WSLDM_IS_ADMIN) env.WSLDM_IS_ADMIN = process.env.WSLDM_IS_ADMIN;

  const serverPath = path.join(ROOT, 'server.js');
  let child;
  try {
    child = fork(serverPath, [], {
      cwd: ROOT,
      env,
      // keep the ipc channel fork requires, but discard the child's stdio
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  } catch (e) {
    log('failed to fork backend:', e.message);
    return;
  }
  backend = child;
  child.on('exit', (code, signal) => {
    log('backend exited code=' + code + ' signal=' + signal);
    // Only clear/restart if THIS child is still the tracked one. During a port
    // change the old child may exit after a new one already started; it must not
    // clobber the new reference.
    if (backend === child) backend = null;
    if (!isQuitting && !restarting && backend === null) {
      setTimeout(() => { if (!isQuitting && !backend) startBackend(); }, 1500);
    }
  });
  log('backend forked (port ' + port + ', data=' + (env.WSLDM_DATA_DIR || '<project>') + ')');
}

function stopBackend() {
  if (!backend) return Promise.resolve();
  const b = backend;
  backend = null;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    b.once('exit', finish);
    try { b.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { b.kill('SIGKILL'); } catch (_) {} finish(); }, 3000);
  });
}

async function restartBackend() {
  restarting = true;
  await stopBackend();
  restarting = false;
  startBackend();
  return waitForPort('127.0.0.1', currentPort, 30000);
}

// ---------------------------------------------------------------- windows
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'WslDockerManager',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    show: false,
    backgroundColor: '#f3f5f9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'app-preload.js'),
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${currentPort}/`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-fail-load', () => {
    if (isQuitting) return;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(`http://127.0.0.1:${currentPort}/`);
    }, 1200);
  });
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    const idx = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['最小化到托盘', '退出程序'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '关闭 WslDockerManager',
      message: '要最小化到托盘后台运行，还是退出程序？',
      detail: '最小化到托盘：窗口隐藏，后端继续在后台运行（右键托盘图标可重新打开或改设置）。\n退出程序：停止后端并完全退出。',
    });
    if (idx === 1) { quitApp(); }
    else { mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 470,
    height: 580,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '设置',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: SETTINGS_PRELOAD,
    },
  });
  settingsWindow.loadFile(SETTINGS_HTML);
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createTray() {
  if (tray) return;
  if (!fs.existsSync(ICON_PATH)) { log('tray icon missing at ' + ICON_PATH); return; }
  tray = new Tray(ICON_PATH);
  tray.setToolTip('WslDockerManager');
  const menu = Menu.buildFromTemplate([
    { label: '打开主界面', click: showMain },
    { label: '设置（端口 / 账户 / 密码）', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', showMain);
}

function showMain() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (!firstRun) {
    createMainWindow();
  } else {
    // still in first-run setup: bring the settings window forward instead
    openSettings();
  }
}

// Fully quit the app: destroy the tray, stop the backend, then app.quit() with an
// app.exit() fallback. Destroying the tray explicitly prevents the Windows
// notification-area icon from lingering after the process is gone, and the
// fallback guarantees the process actually terminates even if app.quit() is
// swallowed (it occasionally is when invoked synchronously from a window close
// handler / tray click on Windows).
function quitApp() {
  isQuitting = true;
  try { if (tray) { tray.destroy(); tray = null; } } catch (_) {}
  if (backend) { try { backend.kill('SIGTERM'); } catch (_) {} }
  setTimeout(() => { try { app.exit(0); } catch (_) {} }, 4000);
  try { app.quit(); } catch (_) {}
}

// ---------------------------------------------------------------- self-elevation
// 让整个应用（含 fork 出的后端子进程）继承管理员权限：注册计划任务 / 安装向导等
// 需要管理员的操作将不再每次弹 UAC。若当前非管理员，则自动以“以管理员身份运行”
// 重新拉起自身并退出当前实例（用户需在 UAC 弹窗点“是”）。若权限检测异常（返回 null）
// 则降级为普通模式继续运行（届时单步操作仍会按需弹 UAC）。
function isAdmin() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))',
    ], { timeout: 3500, windowsHide: true });
    return /true/i.test(out.toString());
  } catch (_) { return null; }
}

function relaunchElevated() {
  const exe = process.execPath;
  const args = process.argv.slice(1).map((a) => '"' + String(a).replace(/"/g, '\\"') + '"');
  const argList = args.length ? (' -ArgumentList ' + args.join(',')) : '';
  const ps = `Start-Process -FilePath "${exe}"${argList} -Verb RunAs`;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
  } catch (_) {}
}

// ---------------------------------------------------------------- IPC (settings)
ipcMain.handle('get-settings', () => {
  const s = readSettings();
  const admin = findAdmin(loadUsers());
  return {
    port: Number(s.port) || 5050,
    username: admin ? admin.username : '',
    hasAdmin: !!admin,
    firstRun,
    dataDir: dataDir(),
  };
});

ipcMain.handle('select-data-dir', () => {
  try {
    const r = dialog.showOpenDialogSync({
      title: '选择文件保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r && r[0] ? r[0] : null;
  } catch (_) { return null; }
});

ipcMain.handle('app-quit', () => { quitApp(); return { ok: true }; });

ipcMain.handle('save-settings', async (evt, data) => {
  try {
    const { port, username, password, dataDir: dataDirInput } = data || {};
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { ok: false, error: '端口必须是 1–65535 之间的整数' };
    }

    // resolve + validate the data directory (where project-generated files live)
    let newDataDir = defaultDataDir();
    if (dataDirInput && String(dataDirInput).trim()) {
      const d = String(dataDirInput).trim();
      newDataDir = path.isAbsolute(d) ? d : path.resolve(d);
    }
    try { fs.mkdirSync(newDataDir, { recursive: true }); }
    catch (e) { return { ok: false, error: '文件保存地址无法创建：' + e.message }; }

    if (!username || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
      return { ok: false, error: '账户名只能包含字母、数字、下划线、点、连字符' };
    }
    if (password != null && password !== '' && String(password).length < 4) {
      return { ok: false, error: '密码至少 4 个字符' };
    }

    const oldPort = Number(readSettings().port) || 5050;
    const oldDataDir = dataDir();
    const dataDirChanged = oldDataDir !== newDataDir;

    // 1) port + data dir -> settings.json
    writeSettings({ port: p, dataDir: newDataDir });

    // 2) admin account/password -> users.json
    const users = loadUsers();
    let admin = findAdmin(users);
    const hash = (password != null && password !== '') ? hashPassword(password) : null;
    if (admin) {
      admin.username = username;
      admin.role = 'admin';
      if (hash) admin.passwordHash = hash;
    } else {
      if (!hash) return { ok: false, error: '首次设置必须填写密码' };
      users.push({ username, passwordHash: hash, role: 'admin' });
    }
    fs.mkdirSync(path.dirname(usersFile()), { recursive: true });
    fs.writeFileSync(usersFile(), JSON.stringify(users, null, 2), 'utf8');
    log('settings saved: port=' + p + ' dataDir=' + newDataDir + ' user=' + username + (hash ? ' (password updated)' : ''));

    // 3) first run: start backend + open main window
    if (firstRun) {
      firstRun = false;
      currentPort = p;
      if (backend) await stopBackend(); // kill any stale backend still holding the port
      startBackend();
      await waitForPort('127.0.0.1', p, 30000);
      createMainWindow();
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
      return { ok: true, started: true };
    }

    // 4) If the data dir / account / password / port changed, the running backend
    //    MUST be restarted. For a data-dir change we additionally stop the backend
    //    FIRST (so files aren't locked) and migrate the old files to the new folder
    //    before starting it with the new WSLDM_DATA_DIR. Skipping this left a STALE
    //    backend (often from an earlier build, or one started with a different data
    //    dir) serving a different users.json, which made the new password fail with
    //    401 "unauthorized" even though it was set correctly.
    if (dataDirChanged || hash || p !== oldPort) {
      currentPort = p;
      if (backend) await stopBackend();
      let migrated = 0;
      if (dataDirChanged) {
        migrated = migrateDataDir(oldDataDir, newDataDir);
        log('data dir changed: ' + oldDataDir + ' -> ' + newDataDir + ' (migrated ' + migrated + ' files)');
      }
      startBackend();
      await waitForPort('127.0.0.1', p, 30000);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(`http://127.0.0.1:${p}/`);
      }
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
      return { ok: true, restarted: true, migrated };
    }

    return { ok: true };
  } catch (err) {
    log('save-settings error: ' + (err && err.message));
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ---------------------------------------------------------------- app lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { showMain(); });

  app.whenReady().then(async () => {
    const t0 = Date.now();
    try { app.setAppUserModelId('com.wsldockermanager.app'); } catch (_) {}

    // 若当前不是管理员，自动提权重新拉起自身（让后端子进程继承管理员权限，
    // 后续“创建保活任务 / 一键安装”等操作均不再弹 UAC）。当前实例退出并释放
    // 单实例锁，提权后的新实例会重新获取锁并正常启动。
    const adm = isAdmin();
    // Tell the forked backend we already know the admin state, so its own
    // ensureElevated() skips spawning PowerShell again (saves ~0.5s at startup).
    if (adm === true) process.env.WSLDM_IS_ADMIN = '1';
    else if (adm === false) process.env.WSLDM_IS_ADMIN = '0';
    log('admin check: ' + adm + ' (' + (Date.now() - t0) + 'ms)');
    if (adm === false) {
      log('非管理员，正在以管理员身份重新拉起…');
      relaunchElevated();
      app.quit();
      return;
    }

    const s = readSettings();
    currentPort = Number(s.port) || 5050;
    firstRun = !findAdmin(loadUsers());
    log('app ready; firstRun=' + firstRun + ' port=' + currentPort + ' packaged=' + app.isPackaged + ' (' + (Date.now() - t0) + 'ms)');

    createTray();

    if (firstRun) {
      // No admin yet: let the user set port + account + password before booting.
      openSettings();
    } else {
      const t1 = Date.now();
      startBackend();
      await waitForPort('127.0.0.1', currentPort, 30000);
      log('backend ready after ' + (Date.now() - t1) + 'ms; creating main window');
      createMainWindow();
    }
  });

  // Keep running in the tray when all windows are closed (unless the user chose quit).
  app.on('window-all-closed', () => { /* stay in tray */ });

  app.on('activate', () => { if (!firstRun && BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

  app.on('before-quit', () => {
    isQuitting = true;
    try { if (tray) { tray.destroy(); tray = null; } } catch (_) {}
    if (backend) { try { backend.kill('SIGTERM'); } catch (_) {} }
  });
}
