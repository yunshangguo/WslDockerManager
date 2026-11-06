// WslDockerManager - Express API server (Stage 2).
// Listens on cfg.port (5050). Talks to the WSL2 dockerd via dockerode + wsl helpers.
const express = require('express');
const path = require('path');
const fs = require('fs');
const cfg = require('./src/config');
const log = require('./src/logger');
const { ping, snapshotRunningContainers, restoreRunningContainers, checkImageUpdates, listContainers, getImageUpdates, updateContainerImage } = require('./src/docker');
const { readSettings } = require('./src/updateSettings');
const { ensureDockerd, startWslKeepAlive, stopWslKeepAlive } = require('./src/wsl');
const prereqs = require('./src/prereqs');
const auth = require('./src/auth');
const { docker } = require('./src/docker');
const { WebSocketServer } = require('ws');

// Self-elevate to Windows administrator on startup (only when run as the entry point,
// i.e. not when forked/required by another module). Keeps the backend process itself
// at host-admin rights without relying on the launcher having been "Run as admin".
if (require.main === module) {
  try { require('./src/elevate').ensureElevated(); } catch (e) { /* ignore */ }
}

// Build marker - bump on every backend change so a status check can confirm the
// NEW code is actually live (vs. an old server.js still bound to 5050).
const BUILD = '2026-11-06g';

const containersRouter = require('./src/routes/containers');
const imagesRouter = require('./src/routes/images');
const volumesRouter = require('./src/routes/volumes');
const networksRouter = require('./src/routes/networks');
const hostRouter = require('./src/routes/host');
const composeRouter = require('./src/routes/compose');
const tasksRouter = require('./src/routes/tasks');
const settingsRouter = require('./src/routes/settings');
const usersRouter = require('./src/routes/users');
const auditRouter = require('./src/routes/audit');
const systemRouter = require('./src/routes/system');
const wslconfigRouter = require('./src/routes/wslconfig');

const app = express();
app.use(express.json());

// ---- auth middleware ----
function requireAuth(req, res, next) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const s = auth.sessionFromToken(token);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  req.session = s;
  next();
}

// Admin-only: requires role === 'admin'.
function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// Tracks whether docker was reachable on the previous health tick, so we can
// fire the "auto-restore previously-running containers" flow exactly once on a
// down -> up transition (covers boot, sleep/resume, and WSL restarts).
let dockerWasUp = false;

// ---- routes ----
// 连接诊断：当系统连接不到 WSL/Docker 时，逐级排查原因（WSL 未装 / 发行版缺失 /
// 发行版未启动 / docker 未装 / dockerd 未起 / 网络与端口配置问题），返回结构化结论，
// 前端据此展示"为什么连不上"。不依赖 docker TCP（那正是失败点），改用 wsl CLI 探活。
app.get('/api/diagnose', requireAuth, async (req, res) => {
  try {
    res.json(await require('./src/wsl').diagnoseConnection());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 环境前置依赖检测：虚拟化 / WSL / Debian / Docker / 必要配置项是否就绪。
// 与 /api/diagnose 不同，这里面向“安装前自检”——不依赖 docker TCP 是否可连，
// 而是用 wsl CLI / PowerShell 逐项探活，给出一份完整清单（每项 ok / 缺失 / 可更新 / 配置缺失）。
// 前端据此在“环境检测”页展示清单，并提供“一键安装并自动配置”。
app.get('/api/prereqs', requireAuth, async (req, res) => {
  try {
    res.json(await prereqs.getPrereqs(req.query.refresh === '1'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 一键安装并自动配置运行环境（提权运行 install/setup-prereqs.ps1）。
// 属系统级操作，仅应用管理员可发起；实际系统级修改通过 UAC 提权完成。
app.post('/api/prereqs/install', requireAuth, requireAdmin, (req, res) => {
  const user = req.session.username;
  const { audit } = require('./src/routes/util');
  const task = tasks.runTask(
    { type: 'prereqs.install', title: '安装并配置 Docker 运行环境', detail: {} },
    async (tk) => {
      const r = await prereqs.runInstall((m) => tk.log(m), (p) => tk.progress(p));
      audit(user, 'prereqs.install', `status=${r.status}`);
      tk.log(r.message || '');
      if (r.status === 'error' || r.status === 'cancelled' || r.status === 'timeout') {
        throw new Error(r.message || '安装未完成');
      }
      return { ok: true, status: r.status, prereqs: r.prereqs };
    }
  );
  res.json({ ok: true, taskId: task.id });
});

// 单独创建/重建“保活计划任务” WslDockerKeepAlive（无需重跑整个安装向导）。
// 仅应用管理员可发起；系统级任务创建通过 UAC 提权或直接创建完成。
app.post('/api/prereqs/keepalive', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await prereqs.ensureKeepAliveTask();
    if (r.ok) {
      prereqs.invalidatePrereqCache();
      res.json({ ok: true, message: r.message });
    } else {
      res.status(400).json({ ok: false, error: r.message });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  let reachable = await ping().catch(() => false);
  // self-heal: if docker is down, try to bring WSL+dockerd up, then re-check.
  // Non-force: ensureDockerd() only restarts dockerd when it is genuinely NOT
  // running (process guard); a transient /_ping blip never kills a healthy daemon.
  if (!reachable) {
    await ensureDockerd().catch(() => {});
    reachable = await ping().catch(() => false);
  }
  // keep the "running set" snapshot fresh whenever docker is up
  if (reachable) {
    snapshotRunningContainers().catch(() => {});
    if (!dockerWasUp) {
      dockerWasUp = true;
      if (cfg.autostartContainers !== false) {
        restoreRunningContainers().catch((e) => log.warn('自动恢复容器失败: ' + e.message));
      }
    }
  } else {
    dockerWasUp = false;
  }
  res.json({ ok: true, uptime: process.uptime(), dockerReachable: reachable });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = auth.login(username, password);
  if (!result) return res.status(401).json({ error: 'invalid credentials' });
  res.json(result);
});

app.get('/api/session', requireAuth, (req, res) => {
  res.json({ authenticated: true, username: req.session.username, role: req.session.role, isAdmin: req.session.role === 'admin' });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const h = req.headers['authorization'] || '';
  auth.logout(h.startsWith('Bearer ') ? h.slice(7) : null);
  res.json({ ok: true });
});

// helper endpoints used by the UI (path translation) - no auth needed (read-only, non-sensitive)
app.get('/api/util/win2wsl', (req, res) => {
  const { winToWsl } = require('./src/wsl');
  res.json({ wsl: winToWsl(req.query.path || '') });
});
app.get('/api/util/wsl2win', (req, res) => {
  const { wslToWin } = require('./src/wsl');
  res.json({ win: wslToWin(req.query.path || '') });
});
// Local filesystem directory browser (no auth; read-only, returns only dir names).
// Used by the build-container volume picker so the user can navigate and select a
// host folder; the picked absolute path is sent to the backend, which creates it
// if missing before binding.
app.get('/api/util/fs-list', (req, res) => {
  try {
    const target = req.query.path || path.parse(process.cwd()).root;
    const abs = path.resolve(target);
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    res.json({ path: abs, entries });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// protected docker API (everything under /api/docker requires a valid session)
app.use('/api/containers', requireAuth, containersRouter);
app.use('/api/images', requireAuth, imagesRouter);
app.use('/api/volumes', requireAuth, volumesRouter);
app.use('/api/networks', requireAuth, networksRouter);
app.use('/api/host', requireAuth, hostRouter);
app.use('/api/compose', requireAuth, composeRouter);
app.use('/api/tasks', requireAuth, tasksRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/users', requireAuth, requireAdmin, usersRouter);
app.use('/api/audit', requireAuth, auditRouter);
app.use('/api/system', requireAuth, requireAdmin, systemRouter);
app.use('/api/wslconfig', requireAuth, requireAdmin, wslconfigRouter);

// legacy aliases (kept for convenience / earlier docs)
app.get('/api/docker/info', requireAuth, async (req, res) => {
  try { res.json(await require('./src/conn').withDockerd(() => require('./src/docker').getInfo())); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/docker/version', requireAuth, async (req, res) => {
  try { res.json(await require('./src/conn').withDockerd(() => require('./src/docker').getVersion())); } catch (e) { res.status(502).json({ error: e.message }); }
});

// Disable HTTP caching for the SPA assets. Without this, the browser can keep
// serving a stale cached views.js / tasks.js / app.js, which makes frontend
// edits appear to "do nothing" and can pin an old template-compile error
// (e.g. "Invalid or unexpected token") even after the source is fixed.
// 'no-store' tells the browser to NEVER cache these files, so every normal
// refresh fetches the current file from disk and a stale bundle can't recur.
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && /\.(js|mjs|css|html|json|map|svg|png|woff2?)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// static SPA (built later by Vite into public/)
app.use(express.static(path.join(cfg.rootDir, 'public')));

const server = app.listen(cfg.port, async () => {
  log.info(`WslDockerManager server listening on http://localhost:${cfg.port}`);
  // Keep the WSL2 distro (and therefore dockerd) permanently awake so it can
  // never auto-suspend after a period of inactivity. The install-time
  // `WslDockerKeepAlive` scheduled task provides the same guarantee when the
  // app is closed; this backend-side child covers the app-is-running case.
  startWslKeepAlive();
  const ok = await ensureDockerd().catch(() => false);
  if (ok) {
    dockerWasUp = true;
    await snapshotRunningContainers().catch(() => {});
    if (cfg.autostartContainers !== false) {
      restoreRunningContainers().catch((e) => log.warn('自动恢复容器失败: ' + e.message));
    }
  } else {
    log.warn('dockerd not reachable at startup; will retry on demand');
  }
  // 启动自检：异步缓存一份环境前置依赖报告（虚拟化/WSL/Debian/Docker/配置），
  // 供前端“环境检测”页与启动横幅使用（失败不影响主服务）。
  // 延后 4s 执行，避免它在应用刚启动、首屏渲染争抢 CPU/进程资源导致“启动慢”。
  setTimeout(() => {
    prereqs.getPrereqs(true).catch((e) => log.warn('环境自检失败（非致命）: ' + (e && e.message)));
  }, 4000);
});

// Clean shutdown: release the keep-alive child so it does not linger as an
// orphan. Docker + Linux persistence after the app closes is handled by the
// install-time `WslDockerKeepAlive` scheduled task, not by this process.
function shutdown() {
  try { stopWslKeepAlive(); } catch (_) {}
}
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('exit', () => { try { stopWslKeepAlive(); } catch (_) {} });

// Self-healing loop: keep WSL + dockerd up without manual intervention
// (covers sleep/resume network drops, reboots where WSL didn't auto-start, and
// the dockerd crash-loop case where dockerd starts but dies ~15-20s later).
// Uses the SAME ping() the frontend uses, so it detects the very same down
// moments (a bare TCP connect to 127.0.0.1:2375 can report "up" on WSL while
// dockerode's real request fails) and triggers recovery on them.
//
// Adaptive cadence: when docker has been reachable for a few consecutive ticks
// we back off to HEALTH_STABLE_MS (low overhead). As soon as a tick finds it
// down (or it has just come back up), we switch to HEALTH_FLAP_MS so the
// crash-loop is recovered within seconds instead of waiting up to 30s.
const HEALTH_STABLE_MS = cfg.selfHealStableMs || 30000;
const HEALTH_FLAP_MS = cfg.selfHealFlapMs || 8000;
const healthSleep = (ms) => new Promise((r) => setTimeout(r, ms));

let consecutiveUp = 0;
let consecutiveDown = 0;

async function healthTick() {
  const reachable = await ping().catch(() => false);
  if (!reachable) {
    dockerWasUp = false;
    consecutiveUp = 0;
    consecutiveDown += 1;
    // Don't fight systemd's Restart=always on the very first missed ping - give
    // a crashing dockerd a couple seconds to be auto-recovered before we step in.
    // Non-force ensureDockerd() only restarts dockerd when it is genuinely NOT
    // running (process guard), so it never kills a healthy/starting daemon.
    if (consecutiveDown >= 2) {
      await ensureDockerd().catch(() => {});
    }
    return HEALTH_FLAP_MS; // docker is down -> recheck soon
  }
  consecutiveDown = 0;
  // docker 刚从不可达恢复：先按"上次运行的快照"拉起容器，再重新同步快照
  if (!dockerWasUp) {
    dockerWasUp = true;
    if (cfg.autostartContainers !== false) {
      await restoreRunningContainers().catch((e) => log.warn('自动恢复容器失败: ' + e.message));
    }
  }
  // 正常 tick：保持快照为最新运行态（恢复后也会覆盖为真实运行集合）
  await snapshotRunningContainers().catch(() => {});
  consecutiveUp += 1;
  // Once stable for 3+ ticks, back off to the slow cadence; otherwise keep
  // probing at the fast cadence (we may still be inside the crash loop).
  return consecutiveUp >= 3 ? HEALTH_STABLE_MS : HEALTH_FLAP_MS;
}

(async function healthLoop() {
  let delay = HEALTH_STABLE_MS;
  // never let a single bad tick kill the loop
  while (true) {
    await healthSleep(delay);
    try {
      delay = await healthTick();
    } catch (e) {
      log.error('health loop tick error: ' + (e && e.message));
      delay = HEALTH_FLAP_MS;
    }
  }
})();

// 定时检测镜像更新：按设置中的 scanIntervalMinutes（默认 6 小时）比对一次本地
// 镜像与远端 registry 的 digest，结果写入 data/image-updates.json，供容器 / 镜像页
// 标记"可更新"徽标。若开启 autoUpdateEnabled，扫描完成后自动把"可更新"的容器
// 拉取最新镜像并按原配置重建。
// 频率由设置决定（0 = 关闭自动扫描），用 updateCheckRunning 守卫避免重叠触发。
let updateCheckRunning = false;
let lastScanAt = 0;
const SCAN_TICK_MS = 60 * 1000; // 每分钟检查一次是否到了扫描时刻

// 判断容器镜像是否有可更新版本（与前端 hasUpdate 同口径：容器可能以无 tag 形式
// 引用镜像，需规范化为 repo:latest 再查一次）。
function containerHasUpdate(c, info) {
  const byRef = info && info.byRef;
  if (!byRef || !c.image) return false;
  if (byRef[c.image] && byRef[c.image].hasUpdate) return true;
  if (c.image.indexOf('@') < 0 && !/:[^/]+$/.test(c.image)) {
    const norm = c.image + ':latest';
    if (byRef[norm] && byRef[norm].hasUpdate) return true;
  }
  return false;
}

async function runScheduledScan() {
  if (updateCheckRunning) return;
  updateCheckRunning = true;
  try {
    const ok = await ping().catch(() => false);
    if (!ok) return;
    const settings = readSettings();
    await checkImageUpdates().catch((e) => log.warn('定时镜像更新检测失败: ' + e.message));
    if (settings.autoUpdateEnabled) {
      const info = getImageUpdates();
      const cts = await listContainers(true).catch(() => []);
      for (const c of cts) {
        if (settings.autoUpdateScope === 'running' && c.state !== 'running') continue;
        if (!containerHasUpdate(c, info)) continue;
        try {
          await updateContainerImage(c.id);
          log.info('自动更新容器: ' + (c.names && c.names[0]));
        } catch (e) {
          log.warn('自动更新容器失败 ' + (c.names && c.names[0]) + ': ' + e.message);
        }
      }
    }
  } catch (e) {
    log.warn('定时镜像更新检测失败: ' + e.message);
  } finally {
    updateCheckRunning = false;
  }
}

// 每分钟判断一次：设置开启且距上次扫描已达设定间隔，就执行一次。
setInterval(() => {
  const s = readSettings();
  if (!s.scanIntervalMinutes || s.scanIntervalMinutes <= 0) return;
  const now = Date.now();
  if (now - lastScanAt >= s.scanIntervalMinutes * 60 * 1000) {
    lastScanAt = now;
    runScheduledScan().catch(() => {});
  }
}, SCAN_TICK_MS);

// 启动后延迟 60s 首次检测（等待 docker / 网络完全就绪，避免开机即卡在 registry 查询）
setTimeout(() => {
  const s = readSettings();
  if (s.scanIntervalMinutes > 0) {
    lastScanAt = Date.now();
    runScheduledScan().catch(() => {});
  }
}, 60000);

// seed admin on boot
auth.seedAdmin();


// ---- WebSocket interactive terminal (P1: 交互式终端) ----
const termWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const m = req.url && req.url.match(/\/ws\/terminal\/([^/?]+)/);
  if (m) termWss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, m[1]));
  else socket.destroy();
});
async function attachTerminal(ws, id) {
  try {
    const exec = await docker.getContainer(id).exec({
      Cmd: ['/bin/sh', '-c', 'TERM=xterm-256color; export TERM; [ -x /bin/bash ] && exec /bin/bash || exec /bin/sh'],
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    stream.on('data', (d) => { try { ws.send(d.toString()); } catch (_) {} });
    ws.on('message', (m) => { try { stream.write(typeof m === 'string' ? Buffer.from(m) : m); } catch (_) {} });
    ws.on('close', () => { try { stream.end(); } catch (_) {} });
    stream.on('end', () => { try { ws.close(); } catch (_) {} });
  } catch (e) {
    try { ws.send('终端连接失败: ' + e.message); ws.close(); } catch (_) {}
  }
}

module.exports = app;
