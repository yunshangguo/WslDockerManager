// Operator settings: Docker registry-mirror configuration inside WSL.
// Writing /etc/docker/daemon.json and restarting docker happens via runWsl
// (root), so the user never has to drop to a shell to fix pull failures.
const express = require('express');
const { runWsl } = require('../wsl');
const d = require('../docker');
const tasks = require('../tasks');
const { asyncHandler, audit } = require('./util');

const router = express.Router();
const DAEMON = '/etc/docker/daemon.json';
const { readSettings, writeSettings } = require('../updateSettings');

// 镜像源地址 -> docker login 用的 host（去掉协议头与路径，保留端口）
function hostOf(u) {
  return String(u || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

async function readMirrors() {
  try {
    const out = await runWsl(['bash', '-c', `cat ${DAEMON} 2>/dev/null || echo '{}'`]);
    const d = JSON.parse(out || '{}');
    return Array.isArray(d['registry-mirrors']) ? d['registry-mirrors'] : [];
  } catch (e) {
    return [];
  }
}

// 写 registry-mirrors 并重启 docker（30s 健康循环会重新绑定 2375）。
async function writeMirrors(mirrors) {
  const py = `import os, json
p='${DAEMON}'
d={}
if os.path.exists(p):
    try:
        d=json.load(open(p))
    except Exception:
        d={}
d['registry-mirrors']=${JSON.stringify(mirrors)}
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(d, open(p,'w'), indent=2)
print('OK')`;
  await runWsl(['python3', '-c', py]);
  try { await runWsl(['systemctl', 'restart', 'docker']); } catch (_) {}
  await new Promise((r) => setTimeout(r, 2500));
}

router.get('/registry-mirror', asyncHandler(async (req, res) => {
  res.json({ mirrors: await readMirrors() });
}));

router.post('/registry-mirror', asyncHandler(async (req, res) => {
  const mirrors = Array.isArray(req.body && req.body.mirrors)
    ? req.body.mirrors.map(String).filter(Boolean)
    : [];
  // Python is reliably present in the Debian WSL image; writing via a single
  // argv avoids shell-quoting problems with the JSON payload.
  const py = `import os, json
p='${DAEMON}'
d={}
if os.path.exists(p):
    try:
        d=json.load(open(p))
    except Exception:
        d={}
d['registry-mirrors']=${JSON.stringify(mirrors)}
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(d, open(p,'w'), indent=2)
print('OK')`;
  await runWsl(['python3', '-c', py]);
  // apply: restart docker (the 30s health loop will re-bind 2375)
  try { await runWsl(['systemctl', 'restart', 'docker']); } catch (_) {}
  await new Promise((r) => setTimeout(r, 2500));
  res.json({ ok: true, mirrors: await readMirrors() });
}));

// 列出已配置的镜像源（registry-mirrors）+ 当前已登录的镜像站 host 列表。
// 前端据此判断每个镜像源是否已登录。无需管理员即可查看。
router.get('/mirror-sources', asyncHandler(async (req, res) => {
  const mirrors = await readMirrors();
  const reg = await d.listRegistries();
  const auths = (reg.registries || []).map((x) => x.host);
  res.json({ ok: true, mirrors, auths });
}));

// 添加镜像源（写入 daemon.json 并重启 docker）。属系统级操作，仅管理员。
// 若同时提供了账号密码，则顺带 docker login 到该镜像源（适用于私有 / 代理源）；
// 公开镜像源（如 1Panel 镜像源）无需账号，留空即可直接添加使用。
router.post('/mirror-sources', asyncHandler(async (req, res) => {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  const { url, username, password } = req.body || {};
  const u = (url || '').trim();
  if (!u) return res.status(400).json({ error: '镜像源地址不能为空' });
  if (!/^https?:\/\//i.test(u)) {
    return res.status(400).json({ error: '镜像源需以 http(s):// 开头，例如 https://docker.1panel.live' });
  }
  const mirrors = (await readMirrors()).map((x) => x.trim());
  if (!mirrors.includes(u)) mirrors.push(u);
  await writeMirrors(mirrors);
  let loginMsg = '';
  if (username && password) {
    try {
      const r = await d.loginRegistry({ registry: hostOf(u), username: String(username).trim(), password });
      loginMsg = '，并已登录：' + (r.registry || hostOf(u));
      audit(req.session.username, 'mirror.login', `host=${hostOf(u)}`);
    } catch (e) {
      return res.status(400).json({ error: '镜像源已添加，但登录失败：' + e.message });
    }
  }
  const reg = await d.listRegistries();
  audit(req.session.username, 'mirror.add', `url=${u}`);
  res.json({ ok: true, mirrors: await readMirrors(), auths: (reg.registries || []).map((x) => x.host), message: '镜像源已添加' + loginMsg });
}));

// 删除镜像源（从 daemon.json 移除并重启 docker）。仅管理员。
router.delete('/mirror-sources', asyncHandler(async (req, res) => {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  const { url } = req.body || {};
  const u = (url || '').trim();
  if (!u) return res.status(400).json({ error: '镜像源地址不能为空' });
  const mirrors = (await readMirrors()).map((x) => x.trim()).filter((x) => x !== u);
  await writeMirrors(mirrors);
  audit(req.session.username, 'mirror.remove', `url=${u}`);
  res.json({ ok: true, mirrors: await readMirrors() });
}));

router.post('/docker/restart', asyncHandler(async (req, res) => {
  try { await runWsl(['systemctl', 'restart', 'docker']); } catch (_) {}
  await new Promise((r) => setTimeout(r, 2000));
  res.json({ ok: true });
}));

// 升级 WSL 内的 Docker 引擎（apt-get update + 升级 docker 组件）。属系统级操作，仅管理员。
// 作为后台任务执行（apt 可能耗时数分钟），立即返回 taskId，前端可轮询进度。
router.post('/docker/update', (req, res) => {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  const user = req.session.username;
  const task = tasks.runTask(
    { type: 'docker.engine.update', title: '更新 Docker 引擎', detail: {} },
    async (tk) => {
      const r = await d.updateDockerEngine((m) => tk.log(m), (p) => tk.progress(p));
      audit(user, 'docker.engine.update', `newVersion=${r.newVersion || '?'} upgraded=${r.upgraded}`);
      tk.log(r.upgraded ? 'Docker 引擎已更新，建议重启 Docker 以应用（概览页「重启 Docker」）。' : '已是最新版本，无需更新。');
      return { ok: true, newVersion: r.newVersion, upgraded: r.upgraded };
    }
  );
  res.json({ ok: true, taskId: task.id });
});

// 登录到指定镜像站（docker login），凭据由 Docker 自身写入 ~/.docker/config.json，后端不持久化密码。
// 属系统级操作，仅管理员。
router.post('/registry/login', asyncHandler(async (req, res) => {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  const { registry, username, password } = req.body || {};
  try {
    const r = await d.loginRegistry({ registry, username, password });
    audit(req.session.username, 'registry.login', `registry=${r.registry}`);
    res.json({ ok: true, registry: r.registry, message: r.message });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// 列出已登录过的镜像站（host 列表，不含凭据）。
router.get('/registry/list', asyncHandler(async (req, res) => {
  res.json(await d.listRegistries());
}));

// 退出指定镜像站登录（docker logout）。仅管理员。
router.post('/registry/logout', asyncHandler(async (req, res) => {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  const { registry } = req.body || {};
  try {
    const r = await d.logoutRegistry(registry);
    audit(req.session.username, 'registry.logout', `registry=${r.registry}`);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// Diagnostic: what registry-mirrors are configured, and whether the upstream
// registries are actually reachable from inside WSL. This is the fastest way to
// tell why a pull fails without scraping daemon logs. Each probe has its own
// short timeout so one dead host cannot hang the whole call.
function probeMirror(url) {
  return runWsl([
    'bash', '-c',
    `code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${url}/v2/" 2>/dev/null); echo "$([ "$code" = "200" ] && echo OK || echo FAIL):$code"`,
  ], { timeout: 15000 }).then((o) => o.trim()).catch((e) => 'ERR:' + e.message.trim());
}

router.get('/diagnose', asyncHandler(async (req, res) => {
  const daemonRaw = await runWsl(['bash', '-c', `cat ${DAEMON} 2>/dev/null || echo '{}'`])
    .catch(() => '{}');
  let mirrors = [];
  try { mirrors = (JSON.parse(daemonRaw || '{}')['registry-mirrors'] || []); } catch (_) {}
  const infoMirrors = await runWsl([
    'bash', '-c', `docker info --format '{{json .RegistryConfig.Mirrors}}' 2>/dev/null || echo '[]'`,
  ], { timeout: 15000 }).catch(() => '[]');
  const dockerHub = await probeMirror('https://registry-1.docker.io');
  const probeResults = {};
  for (const m of mirrors) {
    probeResults[m] = await probeMirror(m.replace(/\/+$/, ''));
  }
  res.json({ daemon: daemonRaw, mirrors, dockerHub, infoMirrors, probe: probeResults });
}));

// 镜像更新扫描设置（扫描频率 + 自动更新）。仅管理员可写。
router.get('/updates', asyncHandler(async (req, res) => {
  res.json(readSettings());
}));

router.post('/updates', asyncHandler(async (req, res) => {
  // 仅管理员可修改更新策略
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  const b = req.body || {};
  const patch = {};
  if (b.scanIntervalMinutes != null) patch.scanIntervalMinutes = Math.max(0, Number(b.scanIntervalMinutes) || 0);
  if (b.autoUpdateEnabled != null) patch.autoUpdateEnabled = !!b.autoUpdateEnabled;
  if (b.autoUpdateScope != null) patch.autoUpdateScope = b.autoUpdateScope === 'all' ? 'all' : 'running';
  const merged = writeSettings(patch);
  res.json({ ok: true, settings: merged });
}));

module.exports = router;
