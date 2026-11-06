// Docker Engine connection via dockerode (TCP to WSL2 dockerd on 127.0.0.1:2375).
// No TLS (localhost only) - the dockerd is bound to 127.0.0.1 by the install script,
// so it is never exposed to the LAN.
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./config');
const log = require('./logger');
const { runWsl, DISTRO } = require('./wsl');

const docker = new Docker({
  host: cfg.dockerHost,
  port: cfg.dockerPort,
});

// ---------------------------------------------------------------------------
// connectivity
// ---------------------------------------------------------------------------
async function ping() {
  try {
    await docker.ping();
    return true;
  } catch (e) {
    log.warn(`docker ping failed: ${e.message}`);
    return false;
  }
}

function getInfo() {
  return docker.info();
}

function getVersion() {
  return docker.version();
}

// ---------------------------------------------------------------------------
// containers
// ---------------------------------------------------------------------------
async function listContainers(all = true) {
  const raw = await docker.listContainers({ all });
  return raw.map(transformContainer);
}

function transformContainer(c) {
  const nets = c.NetworkSettings && c.NetworkSettings.Networks
    ? Object.keys(c.NetworkSettings.Networks).map((k) => c.NetworkSettings.Networks[k])
    : [];
  // 收集所有非空的容器 IP（兼容 bridge / 自定义网络 / 多网络），并回退到旧式顶层 IPAddress。
  const ips = nets.map((n) => (n && n.IPAddress) || '').filter(Boolean);
  const ip = ips[0] || (c.NetworkSettings && c.NetworkSettings.IPAddress) || '';
  return {
    id: c.Id,
    shortId: (c.Id || '').slice(0, 12),
    names: (c.Names || []).map((n) => n.replace(/^\//, '')),
    image: c.Image,
    imageId: c.ImageID,
    command: c.Command,
    created: c.Created,
    state: c.State,
    status: c.Status,
    ports: c.Ports || [],
    sizeRw: c.SizeRw,
    sizeRootFs: c.SizeRootFs,
    labels: c.Labels || {},
    restartCount: c.RestartCount,
    ip,
    ips,
    networks: nets.map((n) => n.Name || '').filter(Boolean),
  };
}

async function inspectContainer(id) {
  return docker.getContainer(id).inspect();
}

async function startContainer(id) {
  await docker.getContainer(id).start();
  return { ok: true };
}

async function stopContainer(id, opts = {}) {
  await docker.getContainer(id).stop({ t: opts.t != null ? opts.t : 10 });
  return { ok: true };
}

async function restartContainer(id, opts = {}) {
  await docker.getContainer(id).restart({ t: opts.t != null ? opts.t : 10 });
  return { ok: true };
}

async function killContainer(id, opts = {}) {
  await docker.getContainer(id).kill({ signal: opts.signal || 'SIGKILL' });
  return { ok: true };
}

async function pauseContainer(id) {
  await docker.getContainer(id).pause();
  return { ok: true };
}

async function unpauseContainer(id) {
  await docker.getContainer(id).unpause();
  return { ok: true };
}

async function removeContainer(id, opts = {}) {
  await docker.getContainer(id).remove({ force: !!opts.force, v: !!opts.v, link: !!opts.link });
  return { ok: true };
}

// Snapshot of live resource usage (non-streaming). Good enough for the Phase 4 UI cards.
async function containerStats(id) {
  return docker.getContainer(id).stats({ stream: false });
}

// Reject a promise if it does not settle within `ms` milliseconds.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} 超时（>${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Derive CPU % and memory usage from a single Docker stats snapshot.
// CPU % = (cpu_delta / system_delta) * 100  （主机相对利用率，0–100%，
//   100% = 占满整台机器的全部核心；而非 Docker 默认的「每核百分比」）
// Memory  = usage - cache (cache is reclaimable, not "real" usage).
// prevSt (optional) is an earlier stats snapshot; if provided its cpu_stats is
// used as the baseline so the CPU % reflects a real elapsed delta (a single
// snapshot always has precpu_stats == cpu_stats, which yields 0%).
function calcContainerUsage(st, prevSt) {
  if (!st) return { cpuPct: 0, memUsage: 0, memLimit: 0, memPct: 0, memCache: 0, onlineCpus: 0 };
  const cur = st.cpu_stats || {};
  const curCpu = cur.cpu_usage || {};
  const prevCpu = (prevSt && prevSt.cpu_stats && prevSt.cpu_stats.cpu_usage) || (st.precpu_stats || {}).cpu_usage || {};
  const prevSys = (prevSt && prevSt.cpu_stats && prevSt.cpu_stats.system_cpu_usage) || (st.precpu_stats || {}).system_cpu_usage || 0;
  const onlineCpus = cur.online_cpus || (curCpu.percpu_usage ? curCpu.percpu_usage.length : 1) || 1;

  const cpuDelta = (curCpu.total_usage || 0) - (prevCpu.total_usage || 0);
  const sysDelta = (cur.system_cpu_usage || 0) - prevSys;
  let cpuPct = 0;
  if (sysDelta > 0 && cpuDelta > 0) {
    cpuPct = (cpuDelta / sysDelta) * 100; // 主机相对利用率（0–100%）
  }
  const mem = st.memory_stats || {};
  const memCache = (mem.stats && mem.stats.cache) || 0;
  const memUsage = Math.max(0, (mem.usage || 0) - memCache);
  const memLimit = mem.limit || 0;
  const memPct = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

  return {
    cpuPct: Math.max(0, Math.min(100, cpuPct)),
    memUsage,
    memLimit,
    memPct: Math.min(100, Math.max(0, memPct)),
    memCache,
    onlineCpus,
  };
}

// Promise/callback-safe single snapshot of a container's stats.
// Newer dockerode returns a promise from stats({stream:false}); older versions
// require the (err, data) callback form. Handle both.
function statsOnce(id) {
  return new Promise((resolve, reject) => {
    const c = docker.getContainer(id);
    let p;
    try { p = c.stats({ stream: false }); } catch (e) { return reject(e); }
    if (p && typeof p.then === 'function') { p.then(resolve, reject); return; }
    c.stats({ stream: false }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// Batch fetch stats for many containers concurrently with a per-container timeout.
// Returns a map of { [id]: result | { error } } where each result contains the
// computed memory figures plus the RAW cpu counters (totalUsage / systemUsage /
// onlineCpus) so the frontend can derive a real CPU% across consecutive polls.
// (A single Docker snapshot has precpu_stats == cpu_stats, which would give a
//  bogus 0% — the elapsed delta must come from two separate reads.)
async function containerStatsBatch(ids) {
  const list = (ids || []).filter(Boolean);
  const out = {};
  await Promise.all(list.map(async (id) => {
    try {
      const st = await withTimeout(statsOnce(id), 5000, `容器 ${id} 统计`);
      const base = calcContainerUsage(st);
      const cur = (st && st.cpu_stats) || {};
      const curCpu = cur.cpu_usage || {};
      out[id] = Object.assign({}, base, {
        cpu: {
          totalUsage: curCpu.total_usage || 0,
          systemUsage: cur.system_cpu_usage || 0,
          onlineCpus: cur.online_cpus || (curCpu.percpu_usage ? curCpu.percpu_usage.length : 1) || 1,
        },
      });
    } catch (e) {
      out[id] = { error: e.message };
    }
  }));
  return out;
}

// Demultiplex docker's 8-byte-header stream frames into {stream, text} entries.
function demuxLogs(buffer) {
  const frames = [];
  let offset = 0;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset]; // 0=stdin,1=stdout,2=stderr
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    const payload = buf.slice(offset, offset + size);
    offset += size;
    frames.push({ stream: streamType === 2 ? 'stderr' : 'stdout', text: payload.toString('utf8') });
  }
  return frames;
}

async function containerLogs(id, opts = {}) {
  const c = docker.getContainer(id);
  const buf = await c.logs({
    stdout: true,
    stderr: true,
    follow: false,
    tail: opts.tail != null ? opts.tail : 100,
    since: opts.since,
    until: opts.until,
    timestamps: !!opts.timestamps,
  });
  return demuxLogs(buf);
}

// Validate + normalize a container name to what Docker accepts.
// Docker requires >=2 chars, starting with [a-zA-Z0-9], and only [a-zA-Z0-9_.-].
// Returns the cleaned name, or undefined to let Docker auto-assign one.
// Throws a Chinese error message if the supplied name is invalid.
function normalizeContainerName(raw) {
  const n = String(raw == null ? '' : raw).trim().replace(/^\/+/, '');
  if (!n) return undefined;
  if (n.length < 2) {
    throw new Error(`容器名「${n}」太短：Docker 要求至少 2 个字符（例如 ${n}01 或 my-${n}）`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(n)) {
    throw new Error(`容器名「${n}」不合法：必须以字母或数字开头，只能包含字母、数字、下划线(_)、点(.)、连字符(-)`);
  }
  return n;
}

// Create + (optionally) start a container from a normalized spec.
// spec: { image, name, cmd[], env[], ports[{host,container,proto}], binds[{win,container,mode}],
//         restartPolicy, networkMode, envFile?, labels, autoRemove, privileged }
async function createContainer(spec, start = true) {
  const { winToWsl } = require('./wsl');
  const ExposedPorts = {};
  const PortBindings = {};
  for (const p of spec.ports || []) {
    const key = `${p.container}/${p.proto || 'tcp'}`;
    ExposedPorts[key] = {};
    PortBindings[key] = [{ HostIp: '0.0.0.0', HostPort: String(p.host) }];
  }
  const Binds = [];
  for (const b of spec.binds || []) {
    const src = b.win ? winToWsl(b.win) : b.wsl;
    // Auto-create the host path if it doesn't exist, so a bind mount never
    // fails on a missing path. For a FILE bind (host path ends with an
    // extension, e.g. C:\app\conf.json) we only create its PARENT directory —
    // creating the path itself as a folder would break the file mount.
    if (b.win && !fs.existsSync(b.win)) {
      const lastSeg = b.win.split(/[\\/]/).pop();
      const looksLikeFile = /\.\w+$/.test(lastSeg);
      const dir = looksLikeFile ? path.dirname(b.win) : b.win;
      try { fs.mkdirSync(dir, { recursive: true }); }
      catch (e) { log.warn(`创建卷挂载路径失败 ${dir}: ${e.message}`); }
    }
    Binds.push(`${src}:${b.container}${b.mode ? ':' + b.mode : ''}`);
  }
  const body = {
    Image: spec.image,
    name: normalizeContainerName(spec.name),
    Cmd: spec.cmd,
    Env: spec.env,
    Labels: spec.labels,
    ExposedPorts,
    HostConfig: {
      PortBindings,
      Binds,
      RestartPolicy: { Name: spec.restartPolicy || 'no', MaximumRetryCount: 0 },
      NetworkMode: spec.networkMode,
      AutoRemove: !!spec.autoRemove,
      Privileged: !!spec.privileged,
    },
  };
  const created = await docker.createContainer(body);
  if (start) {
    await created.start();
    snapshotRunningContainers().catch(() => {});
  }
  return { id: created.id, shortId: created.id.slice(0, 12) };
}

// ---------------------------------------------------------------------------
// container exec (non-interactive shell) + image update/recreate
// ---------------------------------------------------------------------------

// Run a single command inside a container via `docker exec` and return its
// combined output. Used by the UI "终端" tab as a lightweight, non-interactive
// shell. (A fully interactive PTY needs a websocket stream; this covers the
// common "run a command and read the result" use case.)
async function execInContainer(id, cmd) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('命令执行超时（>120s）')), 120000);
    execFile(
      'wsl',
      ['-d', DISTRO, '-u', 'root', 'docker', 'exec', id, 'sh', '-c', cmd],
      { maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) {
          // docker exec returns non-zero when the inner command fails; surface
          // the stderr/stdout so the user can see what went wrong.
          const msg = (stderr || stdout || err.message || '').toString();
          return resolve(msg.trim() || '(命令退出码非零，无输出)');
        }
        resolve(stdout.toString());
      }
    );
  });
}

// Run a docker CLI command inside the WSL distro, streaming each line to onLine.
// Used so that configured registry mirrors (daemon.json) apply to pull/push.
function wslDockerCmd(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'wsl',
      ['-d', DISTRO, '-u', 'root', 'docker', ...args],
      { maxBuffer: 500 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || stdout || err.message || '').toString().trim();
          if (msg && onLine) msg.split('\n').forEach((l) => { const s = l.trim(); if (s) onLine(s); });
          return reject(new Error(msg || 'docker 命令执行失败'));
        }
        resolve({ ok: true });
      }
    );
    if (child.stdout) child.stdout.on('data', (d) => String(d).split('\n').forEach((l) => { const s = l.trim(); if (s && onLine) onLine(s); }));
    if (child.stderr) child.stderr.on('data', (d) => String(d).split('\n').forEach((l) => { const s = l.trim(); if (s && onLine) onLine(s); }));
  });
}

// Pull the latest version of a container's image and recreate the container with
// the SAME configuration (name, image, env, labels, ports, binds, restart policy,
// network). Implements the "更新镜像" action: an updated base image takes effect
// without the user having to manually recreate the container.
// 从 inspect 结果拼出「按原配置重建容器」所需的创建 body。
function buildRecreateBody(insp, overrides = {}) {
  const cfg = insp.Config || {};
  const hc = insp.HostConfig || {};
  const name = (insp.Name || '').replace(/^\//, '');
  const ExposedPorts = {};
  const PortBindings = {};
  const pb = hc.PortBindings || {};
  for (const key of Object.keys(pb)) {
    ExposedPorts[key] = {};
    PortBindings[key] = (pb[key] || []).map((b) => ({ HostIp: b.HostIp || '0.0.0.0', HostPort: String(b.HostPort || '') }));
  }
  const Binds = (hc.Binds && hc.Binds.length)
    ? hc.Binds.slice()
    : (insp.Mounts || []).map((m) => `${m.Source}:${m.Destination}${m.Mode ? ':' + m.Mode : ''}`);
  const body = {
    name,
    Image: cfg.Image,
    Cmd: cfg.Cmd,
    Env: cfg.Env,
    Labels: cfg.Labels || {},
    ExposedPorts,
    HostConfig: {
      PortBindings,
      Binds,
      RestartPolicy: hc.RestartPolicy || { Name: 'no', MaximumRetryCount: 0 },
      NetworkMode: hc.NetworkMode,
      AutoRemove: !!hc.AutoRemove,
      Privileged: !!hc.Privileged,
    },
  };
  // P1.9 配置在线编辑：用覆盖项合并后再重建。
  // 注意：前端 doConfig 以「小驼峰」(restart/autoRemove/cmd/env/labels) 传参，
  // 而 createContainer 的 spec 用「大驼峰」，这里两种都认，避免覆盖项被静默丢弃。
  const ov = overrides || {};
  if (ov.Env && ov.Env.length) body.Env = ov.Env;
  else if (ov.env && ov.env.length) body.Env = ov.env;
  if (ov.Cmd && ov.Cmd.length) body.Cmd = ov.Cmd;
  else if (ov.cmd && ov.cmd.length) body.Cmd = ov.cmd;
  // 重启策略：前端可能以 restart（策略名字符串）或 RestartPolicy（对象）两种形式传入
  const rp = ov.RestartPolicy
    || (ov.restart ? { Name: ov.restart, MaximumRetryCount: ov.restart === 'on-failure' ? (Number(ov.maximumRetryCount) || 0) : 0 } : null);
  if (rp) body.HostConfig.RestartPolicy = rp;
  // 自动移除：前端以 autoRemove 传入
  if (ov.AutoRemove !== undefined) body.HostConfig.AutoRemove = !!ov.AutoRemove;
  else if (ov.autoRemove !== undefined) body.HostConfig.AutoRemove = !!ov.autoRemove;
  // 标签
  if (ov.Labels && Object.keys(ov.Labels).length) body.Labels = ov.Labels;
  else if (ov.labels && Object.keys(ov.labels).length) body.Labels = ov.labels;
  if (Array.isArray(ov.Ports)) {
    body.ExposedPorts = {}; body.HostConfig.PortBindings = {};
    for (const p of ov.Ports) {
      const key = `${p.container}/${p.proto || 'tcp'}`;
      body.ExposedPorts[key] = {};
      body.HostConfig.PortBindings[key] = [{ HostIp: '0.0.0.0', HostPort: String(p.host || '') }];
    }
  }
  return body;
}

// 删除原容器，按 inspect 原配置重建并启动（不拉取新镜像）。
async function recreateContainer(id, overrides) {
  const insp = await docker.getContainer(id).inspect();
  if (!insp.Config || !insp.Config.Image) throw new Error('无法读取容器配置，无法重建');
  await docker.getContainer(id).remove({ force: true });
  const created = await docker.createContainer(buildRecreateBody(insp, overrides));
  await created.start();
  snapshotRunningContainers().catch(() => {});
  return { id: created.id, shortId: created.id.slice(0, 12) };
}

async function updateContainerImage(id) {
  const insp = await docker.getContainer(id).inspect();
  const image = insp.Config && insp.Config.Image;
  if (!image) throw new Error('无法读取容器镜像信息');

  // 1) pull latest image (configured mirrors apply via the WSL docker CLI)
  await wslDockerCmd(['pull', image], () => {});

  // 2) remove the old container (force), then recreate from the inspected config
  await docker.getContainer(id).remove({ force: true });
  const created = await docker.createContainer(buildRecreateBody(insp));
  await created.start();
  // 拉取成功后立即刷新「可更新」缓存，使徽标消失（不阻塞主流程）
  revalidateImageUpdate(image).catch(() => {});
  return { id: created.id, shortId: created.id.slice(0, 12) };
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------
async function listImages() {
  const [raw, cts] = await Promise.all([
    docker.listImages({ all: false }),
    docker.listContainers({ all: true }).catch(() => []),
  ]);
  const usedIds = new Set((cts || []).map((c) => c.ImageID).filter(Boolean));
  return raw.map((im) => ({ ...im, inUse: usedIds.has(im.Id) }));
}

async function inspectImage(id) {
  return docker.getImage(id).inspect();
}

async function removeImage(id, opts = {}) {
  // 服务端兜底：镜像正被任何容器（运行或停止）引用时，禁止删除，返回中文提示。
  // 即使前端已经拦截，这里再做一层保护，避免误删导致容器配置丢失。
  const cts = await docker.listContainers({ all: true }).catch(() => []);
  const used = (cts || []).some((c) => c.ImageID === id);
  if (used) {
    throw new Error('该镜像正在被容器使用，无法删除。请先删除（或彻底移除）引用它的容器，再删除镜像。');
  }
  await docker.getImage(id).remove({ force: !!opts.force, noprune: false });
  return { ok: true };
}

function pruneImages() {
  return docker.pruneImages();
}

// Create a new tag (alias) for an image. `target` is a full ref like
// "registry/namespace/repo:tag" or "repo:tag"; we split into repo/tag for dockerode.
async function tagImage(id, target) {
  if (!target) throw new Error('tag target is required');
  let repo = target;
  let tag = 'latest';
  const i = target.lastIndexOf(':');
  const slash = target.lastIndexOf('/');
  if (i > slash) { repo = target.slice(0, i); tag = target.slice(i + 1); }
  await docker.getImage(id).tag({ repo, tag });
  return { ok: true, ref: repo + ':' + tag };
}

// Push an image ref to its registry via the WSL docker CLI so that stored
// credentials (docker login) are used. Streams each output line to onLine so
// callers can surface progress in a background task.
function pushImage(ref, onLine) {
  return new Promise((resolve, reject) => {
    const args = ['-d', DISTRO, '-u', 'root', 'docker', 'push', ref];
    const child = execFile('wsl', args, { maxBuffer: 500 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message || '').toString().trim();
        if (msg && onLine) { msg.split('\n').forEach((l) => { const s = l.trim(); if (s) onLine(s); }); }
        return reject(new Error(msg || 'docker push failed'));
      }
      resolve({ ok: true });
    });
    if (child.stdout) {
      child.stdout.on('data', (d) => {
        String(d).split('\n').forEach((l) => { const s = l.trim(); if (s && onLine) onLine(s); });
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        String(d).split('\n').forEach((l) => { const s = l.trim(); if (s && onLine) onLine(s); });
      });
    }
  });
}

// Pull an image. If onEvent is provided it is called for every progress event
// emitted by the docker daemon (status / progress / progressDetail), so callers
// can stream layer progress into a background task.
function normalizePullError(e) {
  if (!e) return 'unknown pull error';
  // dockerode sometimes nests the real message under e.json.message or e.reason
  let msg = e.message || e.reason || String(e);
  if (e.json && e.json.message) msg = e.json.message;
  // trim the noisy "pull image ...: " dockerode prefixes
  msg = msg.replace(/^pull image [^\s]+:\s*/i, '');
  return msg;
}

function pullImage(repoTag, onEvent) {
  return new Promise((resolve, reject) => {
    docker.pull(repoTag, (err, stream) => {
      if (err) return reject(new Error(normalizePullError(err)));
      // NOTE: followProgress is on the Docker prototype, NOT on docker.modem.
      docker.followProgress(
        stream,
        (e, output) => {
          if (e) return reject(new Error(normalizePullError(e)));
          // 拉取成功后刷新「可更新」缓存，使徽标立即消失
          revalidateImageUpdate(repoTag).catch(() => {});
          resolve(output);
        },
        onEvent
          ? (evt) => { try { onEvent(evt); } catch (_) {} }
          : undefined
      );
    });
  });
}

// ---------------------------------------------------------------------------
// volumes
// ---------------------------------------------------------------------------
async function listVolumes() {
  const r = await docker.listVolumes();
  return { volumes: r.Volumes || [], warnings: r.Warnings || [] };
}

async function inspectVolume(name) {
  return docker.getVolume(name).inspect();
}

async function removeVolume(name) {
  await docker.getVolume(name).remove();
  return { ok: true };
}

function pruneVolumes() {
  return docker.pruneVolumes();
}

async function createVolume(spec = {}) {
  const v = await docker.createVolume({
    Name: spec.name,
    Driver: spec.driver || 'local',
    Labels: spec.labels,
    Options: spec.options,
  });
  return v;
}

// ---------------------------------------------------------------------------
// networks
// ---------------------------------------------------------------------------
async function listNetworks() {
  return docker.listNetworks();
}

async function inspectNetwork(id) {
  return docker.getNetwork(id).inspect();
}

async function removeNetwork(id) {
  await docker.getNetwork(id).remove();
  return { ok: true };
}

function pruneNetworks() {
  return docker.pruneNetworks();
}

async function createNetwork(spec = {}) {
  const n = await docker.createNetwork({
    Name: spec.name,
    Driver: spec.driver || 'bridge',
    Options: spec.options,
    Labels: spec.labels,
    IPAM: spec.ipam,
  });
  return { id: n.id, name: spec.name };
}

// ---------------------------------------------------------------------------
// host / WSL resources (used by the Phase 4 monitor page)
// ---------------------------------------------------------------------------

// 解析 /proc/stat 首行，返回累计 idle 与 total 时钟数（用于两次采样求 CPU 占用率）。
function parseCpuStat(s) {
  const line = (s || '').split('\n').find((x) => x.startsWith('cpu ')) || 'cpu 0 0 0 0';
  const p = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (p[3] || 0) + (p[4] || 0); // idle + iowait
  const total = p.reduce((a, b) => a + b, 0) || 1;
  return { idle, total };
}

// 采集「宿主机（Windows）实际磁盘」，而非 WSL 内部挂载点。
// 后端进程运行在 Windows 宿主机上，直接用 PowerShell 的 Win32_LogicalDisk 取所有本地固定盘
// （DriveType=3）。这样概览页显示的是真实机器的 C:、D: 等磁盘，而不是 WSL 里 /、/mnt/c 那套视图。
// 存储池（Storage Spaces 等）在 Windows 上本就呈现为单一卷，天然不会拆成底层磁盘。
function getHostDisks() {
  return new Promise((resolve) => {
    const script =
      'Get-CimInstance Win32_LogicalDisk -Filter DriveType=3 | ' +
      'Select-Object DeviceID,Size,FreeSpace,FileSystem | ConvertTo-Json -Compress';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        const disks = [];
        if (!err && stdout && stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout.trim());
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const d of arr) {
              const total = Number(d.Size) || 0;
              const free = Number(d.FreeSpace) || 0;
              if (!total) continue;
              const used = Math.max(0, total - free);
              disks.push({
                device: d.DeviceID,
                mountpoint: d.DeviceID,
                fstype: d.FileSystem || '',
                totalBytes: total,
                usedBytes: used,
                availableBytes: free,
                usedPct: total ? used / total : 0,
                isPool: false,
              });
            }
          } catch (e) { /* 解析失败 → 返回空，由上层标记错误 */ }
        }
        resolve(disks);
      }
    );
  });
}

// PowerShell 不可用时的兜底：用 wmic 取同样的本地固定盘信息（仍是宿主机视角）。
function getHostDisksWmic() {
  return new Promise((resolve) => {
    execFile(
      'wmic',
      ['logicaldisk', 'where', 'DriveType=3', 'get', 'DeviceID,Size,FreeSpace,FileSystem', '/format:csv'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        const disks = [];
        if (!err && stdout && stdout.trim()) {
          const lines = stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
          if (lines.length > 1) {
            const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
            const idx = {};
            header.forEach((h, i) => { idx[h] = i; });
            for (let i = 1; i < lines.length; i++) {
              const p = lines[i].split(',');
              const dev = p[idx['deviceid']];
              const size = Number(p[idx['size']]);
              const free = Number(p[idx['freespace']]);
              if (!size) continue;
              const used = Math.max(0, size - free);
              disks.push({
                device: dev,
                mountpoint: dev,
                fstype: p[idx['filesystem']] || '',
                totalBytes: size,
                usedBytes: used,
                availableBytes: free,
                usedPct: size ? used / size : 0,
                isPool: false,
              });
            }
          }
        }
        resolve(disks);
      }
    );
  });
}

// 一次性在 WSL 内收集所有互不依赖的探针（free / nproc / model / arch / loadavg /
// 两次 /proc/stat 采样），只拉起「一个」wsl.exe 进程；CPU 占用率所需的 ~300ms
// sleep 也直接塞进这个脚本里。原先是 7 次 wsl.exe 各自冷启动（每次 ~0.2s，若 WSL
// 发行版处于冷启动会更慢、7 倍惩罚），合并后整体从 ~1.4s 降到 ~0.6s，并顺带几乎
// 消除了「并发多个 wsl 实例把 WSL 卡死 ~30s」的风险。
const WSL_RESOURCE_PROBE = [
  'echo "===MEM==="',
  'free -b',
  'echo "===NPROC==="',
  'nproc',
  'echo "===MODEL==="',
  "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ *//'",
  'echo "===ARCH==="',
  'uname -m',
  'echo "===LOAD==="',
  'cat /proc/loadavg',
  'echo "===STAT1==="',
  'cat /proc/stat',
  'sleep 0.3',
  'echo "===STAT2==="',
  'cat /proc/stat',
].join('\n');

function parseWslSections(out) {
  const parts = (out || '').split(/^===([A-Z0-9_]+)===$/m);
  const map = {};
  for (let i = 1; i < parts.length; i += 2) map[parts[i]] = parts[i + 1] || '';
  return map;
}

async function getWslResourcesImpl() {
  const result = { memory: {}, cpu: {}, disk: {}, configuredMemoryLimit: null };
  // 唯一的 wsl.exe 进程 + 并行的 PowerShell 宿主机磁盘查询
  const [probe, hostDisks] = await Promise.all([
    runWsl(['bash', '-c', WSL_RESOURCE_PROBE]).catch(() => ''),
    getHostDisks(),
  ]);
  const sec = parseWslSections(probe);

  // 内存
  try {
    const memLine = (sec.MEM || '').split('\n').find((l) => l.startsWith('Mem:'));
    if (memLine) {
      const p = memLine.trim().split(/\s+/);
      result.memory.totalBytes = +p[1];
      result.memory.usedBytes = +p[2];
      result.memory.freeBytes = +p[3];
      result.memory.usedPct = result.memory.totalBytes ? Math.round((result.memory.usedBytes / result.memory.totalBytes) * 100) : 0;
    }
    const swapLine = (sec.MEM || '').split('\n').find((l) => l.startsWith('Swap:'));
    if (swapLine) {
      const p = swapLine.trim().split(/\s+/);
      result.memory.swapTotalBytes = +p[1];
      result.memory.swapUsedBytes = +p[2];
    }
  } catch (e) {
    result.memory.error = e.message;
  }

  // CPU 核心数 / 型号 / 架构 / 1 分钟负载
  try { result.cpu.cores = parseInt((sec.NPROC || '').trim(), 10); } catch (e) { result.cpu.error = e.message; }
  result.cpu.model = (sec.MODEL || '').trim() || '未知';
  result.cpu.arch = (sec.ARCH || '').trim();
  try { const parts = (sec.LOAD || '').trim().split(/\s+/); result.cpu.load1 = parseFloat(parts[0]) || 0; } catch (e) { /* ignore */ }

  // CPU 占用率：脚本里 STAT1 / sleep 0.3 / STAT2 已顺序采样，直接求差值
  try {
    const m1 = parseCpuStat(sec.STAT1);
    const m2 = parseCpuStat(sec.STAT2);
    const total = m2.total - m1.total || 1;
    const idle = m2.idle - m1.idle;
    result.cpu.usagePct = Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
  } catch (e) {
    result.cpu.usageError = e.message;
  }

  // 磁盘（宿主机 Windows 逻辑盘）
  try {
    // 扫描「实际宿主机」的磁盘（Windows 逻辑盘 C:/D:/E: …），不再扫描 WSL 内挂载点。
    // 每个本地固定盘一个圆圈；存储池在 Windows 上本就呈现为单一卷，不会拆成底层磁盘。
    let disks = hostDisks || [];
    if (!disks.length) disks = await getHostDisksWmic(); // 兜底：wmic
    result.disks = disks;
    result.hasStoragePool = disks.some((d) => d.isPool);
    // 向后兼容：disk = 系统盘(C:) 或首个磁盘
    const sys = disks.find((d) => /^C:/i.test(d.device)) || disks[0] || null;
    if (sys) {
      result.disk.totalBytes = sys.totalBytes;
      result.disk.usedBytes = sys.usedBytes;
      result.disk.availableBytes = sys.availableBytes;
    }
    if (!disks.length) result.disksError = '未能从宿主机获取磁盘信息（PowerShell / wmic 均不可用？）';
  } catch (e) {
    result.disk.error = e.message;
    result.disksError = e.message;
  }

  // .wslconfig memory cap (from the Windows user profile)
  try {
    const wslconfig = fs.readFileSync(path.join(process.env.USERPROFILE || '', '.wslconfig'), 'utf8');
    const m = wslconfig.match(/memory\s*=\s*([0-9]+)(GB|MB|KB)?/i);
    if (m) result.configuredMemoryLimit = m[1] + (m[2] ? m[2].toUpperCase() : '');
  } catch (e) {
    /* not configured */
  }
  return result;
}

// 单飞缓存：getWslResourcesImpl 会拉起多个 wsl.exe / PowerShell 进程，若同一时刻
// 有多个请求（例如概览页刷新与 /api/host/overview 叠加）并发触发，WSL 对并发实例
// 的串行化会让整体卡到 ~30s。这里让并发调用共享同一次计算（5s 内复用），
// 既消除挂起又顺便给概览页做了轻量缓存。公开导出的 getWslResources 即走此缓存。
let _wslRes = { at: 0, p: null };
function getWslResources() {
  const now = Date.now();
  if (_wslRes.p && now - _wslRes.at < 10000) return _wslRes.p;
  const p = getWslResourcesImpl().catch((e) => { _wslRes.p = null; throw e; });
  _wslRes = { at: now, p };
  return p;
}

async function getOverview() {
  const [info, version, wsl] = await Promise.all([
    getInfo().catch((e) => ({ error: e.message })),
    getVersion().catch((e) => ({ error: e.message })),
    getWslResources().catch((e) => ({ error: e.message })),
  ]);
  return { engine: info, version, wsl };
}

// 升级 WSL 内 Docker 引擎：apt-get update + 仅升级 docker 相关组件。
// onLog(msg) 把分阶段日志推给调用方（通常是后台任务日志），避免长时间无输出。
// onProgress(pct) 推送 0-100 进度，供前端在「Docker 引擎管理」卡片内展示进度条。
// 兼容 docker-ce（官方仓库）与 docker.io（Debian 仓库）两种安装方式。
async function updateDockerEngine(onLog, onProgress) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  const safeRun = async (cmd, timeout) => {
    const out = await runWsl(['bash', '-c', cmd], { timeout: timeout || 600000 });
    return (out || '').trim();
  };
  prog(5); // 开始
  // 1) 识别已安装的 docker 包，决定升级哪些
  let pkgs = 'docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin';
  try {
    const which = await safeRun("if dpkg -l | grep -qE '^ii  docker-ce '; then echo ce; elif dpkg -l | grep -qE '^ii  docker.io '; then echo io; else echo ce; fi", 30000);
    if (which.indexOf('io') >= 0) {
      pkgs = 'docker.io';
      log('检测到 Debian 官方 docker.io 包，将升级 docker.io');
    } else {
      log('检测到 docker-ce 包，将升级 docker 全套组件');
    }
  } catch (e) {
    log('识别 docker 安装类型失败，按 docker-ce 处理：' + e.message);
  }
  prog(15);
  // 2) 刷新软件包索引
  log('步骤 1/3：刷新软件包索引 (apt-get update)…');
  const upd = await safeRun('apt-get update -y 2>&1', 300000);
  log(upd ? upd.split('\n').slice(-6).join('\n') : '(无输出)');
  prog(50); // 索引刷新完
  // 3) 仅升级 docker 组件（不升级其它系统包，避免误动）
  log('步骤 2/3：升级 Docker 引擎组件 (--only-upgrade)…');
  const upg = await safeRun(`DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y ${pkgs} 2>&1`, 600000);
  log(upg ? upg.split('\n').slice(-10).join('\n') : '(无输出)');
  prog(90); // 升级完
  // 4) 读取升级后的版本（apt 升级可能重启 docker 服务，本地 CLI 仍可用）
  let newVersion = '';
  try { newVersion = (await runWsl(['docker', 'version', '--format', '{{.Server.Version}}'])).trim(); } catch (_) {}
  log('步骤 3/3：完成。当前 Docker 版本：' + (newVersion || '未知'));
  const nothing = /0 upgraded/.test(upg) || /already/.test(upg) || /is already the newest/.test(upg);
  prog(100);
  return { newVersion, upgraded: !nothing, raw: upg };
}

// 登录到指定镜像站（docker login），密码通过 stdin 传入避免 shell 转义问题。
function loginRegistry({ registry, username, password }) {
  return new Promise((resolve, reject) => {
    if (!registry || !registry.trim()) return reject(new Error('镜像站地址不能为空'));
    if (!username || !username.trim()) return reject(new Error('用户名不能为空'));
    if (!password) return reject(new Error('密码不能为空'));
    const args = ['-d', DISTRO, '-u', 'root', 'docker', 'login', registry.trim(), '-u', username.trim(), '--password-stdin'];
    const p = execFile('wsl', args, { timeout: 60000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const out = (stdout || '').toString().trim();
        const errMsg = (stderr || '').toString().trim();
        return reject(new Error((errMsg || out || err.message || 'docker login 失败')));
      }
      resolve({ ok: true, registry: registry.trim(), message: (stdout || '').toString().trim() });
    });
    try {
      p.stdin.write(password + '\n');
      p.stdin.end();
    } catch (e) {
      return reject(new Error('写入密码失败: ' + e.message));
    }
  });
}

// 列出已在 WSL 内登录过的镜像站（读取 ~/.docker/config.json 的 auths 主机列表，不含凭据）。
async function listRegistries() {
  try {
    const out = await runWsl(['bash', '-c', 'cat ~/.docker/config.json 2>/dev/null || echo "{}"']);
    const cfg = JSON.parse(out || '{}');
    const auths = cfg.auths || {};
    const list = Object.keys(auths).map((host) => {
      const a = auths[host] || {};
      return { host, identity: a.identitytoken ? 'token' : (a.auth ? 'basic' : 'unknown'), hasCredential: !!(a.auth || a.identitytoken) };
    });
    return { registries: list };
  } catch (e) {
    return { registries: [], error: e.message };
  }
}

// 退出指定镜像站登录（docker logout），凭据由 Docker 自身从 ~/.docker/config.json 移除。
async function logoutRegistry(registry) {
  if (!registry || !registry.trim()) throw new Error('镜像站地址不能为空');
  await runWsl(['docker', 'logout', registry.trim()]);
  return { ok: true, registry: registry.trim() };
}


// ---------------------------------------------------------------------------
// container rename / prune / image import
// ---------------------------------------------------------------------------
async function renameContainer(id, newName) {
  const name = normalizeContainerName(newName);
  if (!name) throw new Error('容器名不能为空');
  await docker.getContainer(id).rename({ name });
  return { ok: true, name };
}

async function pruneContainers() {
  const r = await docker.pruneContainers();
  const reclaimed = Array.isArray(r.ContainersDeleted) ? r.ContainersDeleted.length : 0;
  return { reclaimed, raw: r };
}

// ---------------------------------------------------------------------------
// 自动恢复：记录"正在运行的容器"集合，项目重启后自动拉起它们；
// 停止的容器不在记录中，因此不会被启动。
// ---------------------------------------------------------------------------

// 快照文件落在数据目录下（config.js 已解析为绝对路径 dataDirAbs）。
const RUNNING_SNAPSHOT_FILE = path.join(cfg.dataDirAbs || path.join(__dirname, '..', 'data'), 'running-containers.json');

// 把当前正在运行的容器（shortId 列表）记录到磁盘。
// 只在 docker 可达时调用，由健康循环 / 启动钩子驱动，保证记录反映的是
// "最近一次正常运行时"的状态。
async function snapshotRunningContainers() {
  try {
    const raw = await docker.listContainers({ all: false }); // 仅运行中的
    const ids = (raw || []).map((c) => (c.Id || '').slice(0, 12)).filter(Boolean);
    try { fs.mkdirSync(path.dirname(RUNNING_SNAPSHOT_FILE), { recursive: true }); } catch (_) {}
    fs.writeFileSync(RUNNING_SNAPSHOT_FILE, JSON.stringify({ at: Date.now(), ids }, null, 2), 'utf8');
    return ids;
  } catch (e) {
    log.warn(`记录运行容器快照失败: ${e.message}`);
    return null;
  }
}

// 项目启动 / WSL 从休眠恢复后：把"上次在运行的容器"重新拉起。
// 只启动快照中存在、当前仍存在且未运行的容器；其余（停止/缺失）一律不动。
// 返回 { started, alreadyRunning, missing, failed } 供日志/前端展示。
async function restoreRunningContainers() {
  let snap;
  try {
    if (!fs.existsSync(RUNNING_SNAPSHOT_FILE)) {
      return { started: [], alreadyRunning: [], missing: [], failed: [], note: 'no-snapshot' };
    }
    snap = JSON.parse(fs.readFileSync(RUNNING_SNAPSHOT_FILE, 'utf8'));
  } catch (e) {
    return { started: [], alreadyRunning: [], missing: [], failed: [], note: 'snapshot-unreadable' };
  }
  const ids = (snap.ids || []).filter(Boolean);
  if (!ids.length) return { started: [], alreadyRunning: [], missing: [], failed: [], note: 'empty' };

  // 取当前所有容器（含停止），按 12 位 shortId 建索引，判定存在性与状态。
  const all = await docker.listContainers({ all: true }).catch(() => []);
  const byShort = new Map();
  for (const c of (all || [])) byShort.set((c.Id || '').slice(0, 12), c);

  const started = [], alreadyRunning = [], missing = [], failed = [];
  for (const id of ids) {
    const c = byShort.get(id);
    if (!c) { missing.push(id); continue; }
    if (c.State === 'running') { alreadyRunning.push(id); continue; }
    try {
      await docker.getContainer(c.Id).start();
      started.push(id);
    } catch (e) {
      failed.push({ id, error: e.message });
    }
  }
  log.info(`自动恢复容器：启动 ${started.length} 个、已运行 ${alreadyRunning.length} 个、缺失 ${missing.length} 个、失败 ${failed.length} 个`);
  return { started, alreadyRunning, missing, failed };
}

// ---------------------------------------------------------------------------
// 镜像更新检测：对比本地 RepoDigests 与远端 manifest digest，标出可更新的镜像。
// 仅当本地有 RepoDigests（即由 registry 拉取 / 构建后 push 过）时才可比对；
// 本地 build 或 docker load 进来的镜像没有 RepoDigests，无法比对，自然跳过。
// ---------------------------------------------------------------------------

// 更新检测结果落盘位置（数据目录下 image-updates.json）。
const UPDATES_FILE = path.join(cfg.dataDirAbs || path.join(__dirname, '..', 'data'), 'image-updates.json');

// 通过 WSL docker CLI 解析某镜像引用的远端 manifest digest。
// 复用 daemon.json 中配置的镜像源 / 凭证；多架构镜像取 manifest list 的 digest，
// 单架构镜像取 manifest 的 digest，二者都正好等于本地 RepoDigests 中存储的值，可直接比对。
// 注意：绝不能拿 manifests[].digest（单个架构的 digest）来比对——它会和本地存的不一致，导致误报“有更新”。
// 设置 DOCKER_CLI_EXPERIMENTAL=enabled 以兼容较旧的 Docker CLI（新版已内置 manifest 子命令）。
function inspectManifestDigest(ref) {
  return new Promise((resolve, reject) => {
    // 主方法：buildx imagetools inspect 直接给出“引用(标签)对应的 digest”——
    // 多架构镜像 = 索引(index) digest，单架构镜像 = manifest digest，二者都正好等于
    // 本地 RepoDigests 中存储的值，比对最可靠。这是首选，因为它能拿到索引 digest，
    // 而 `manifest inspect --verbose` 只能拿到逐平台 manifest digest（会和本地索引 digest 不一致）。
    buildxDigest(ref)
      .then(resolve)
      .catch((be) => {
        // 兜底：docker manifest inspect（非 --verbose）
        const args = ['-d', DISTRO, '-u', 'root', 'env', 'DOCKER_CLI_EXPERIMENTAL=enabled', 'docker', 'manifest', 'inspect', ref];
        execFile('wsl', args, { timeout: 25000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          const out = (stdout || '').toString();
          const errOut = (stderr || '').toString();
          if (err) {
            const m = (errOut || out || err.message || '').trim();
            return reject(new Error(enhanceNetError('manifest inspect 失败: ' + m) + (be && be.message ? ' | buildx: ' + be.message : '')));
          }
          let parsed;
          try {
            parsed = JSON.parse(out);
          } catch (e) {
            // 输出不是 JSON（可能是报错文本），把原文带出来方便排查
            return reject(new Error('manifest inspect 输出非 JSON: ' + (out || errOut || err.message || '').slice(0, 400) + (be && be.message ? ' | buildx: ' + be.message : '')));
          }
          // 镜像源常把错误包成 {"errors":[...]} 并以 exit 0 返回（如未登录导致的 UNAUTHORIZED）。
          // 必须单独识别，否则会被误判成“解析不出 digest”，掩盖真正的失败原因。
          if (parsed && Array.isArray(parsed.errors) && parsed.errors.length) {
            const msg = parsed.errors.map((x) => x.message || x.code || JSON.stringify(x)).join('; ');
            return reject(new Error('镜像源返回错误（可能需要 docker login）: ' + msg));
          }
          const digest = extractManifestDigest(parsed);
          if (digest) return resolve(digest);
          reject(new Error('无法从 manifest 解析出 digest（镜像源可能不支持 manifest 查询或需要登录）。原始输出: ' + out.slice(0, 400) + (be && be.message ? ' | buildx: ' + be.message : '')));
        });
      });
  });
}

// 从 manifest 解析结果中提取用于比对的 digest。
// 注意：`docker manifest inspect --verbose` 对多架构镜像返回的是“逐平台 manifest digest”数组，
// 不能拿它和本地索引 digest 比（会误报“有更新”）；只有单平台（数组长度 1）时才取它。
function extractManifestDigest(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed)) {
    // 仅单平台镜像的 --verbose 输出可信
    if (parsed.length === 1 && parsed[0] && parsed[0].Descriptor && typeof parsed[0].Descriptor.digest === 'string') {
      return parsed[0].Descriptor.digest;
    }
    return null; // 多架构：此处取不到索引 digest，交由 buildx 处理
  }
  if (typeof parsed.digest === 'string') return parsed.digest;
  if (parsed.Descriptor && typeof parsed.Descriptor.digest === 'string') return parsed.Descriptor.digest;
  if (parsed.descriptor && typeof parsed.descriptor.digest === 'string') return parsed.descriptor.digest;
  if (parsed.schemaV2ManifestList && typeof parsed.schemaV2ManifestList.digest === 'string') return parsed.schemaV2ManifestList.digest;
  if (parsed.schemaV2Manifest && typeof parsed.schemaV2Manifest.digest === 'string') return parsed.schemaV2Manifest.digest;
  return null;
}

// 把底层 docker/wsl 的网络类错误翻译成更易读的中文提示，便于定位“镜像源不可达”问题。
function enhanceNetError(msg) {
  if (!msg) return msg;
  const m = String(msg);
  if (/i\/o timeout|dial tcp .*timeout|context deadline exceeded|Client\.Timeout|TLS handshake timeout/i.test(m)) {
    return '镜像源网络超时（连接超时）：请检查 WSL 网络 / DNS，或镜像源（如 docker.1panel.live）当前是否可达';
  }
  if (/no route to host|network is unreachable|host is down/i.test(m)) {
    return '镜像源网络不可达：WSL 无法路由到该镜像源，请检查网络 / DNS 设置';
  }
  if (/connection refused|connection reset by peer|EOF/i.test(m)) {
    return '镜像源连接被拒绝或重置：请确认镜像源地址正确且服务可用';
  }
  return m;
}

// 兜底/主方案：docker buildx imagetools inspect 直接取 RepoDigest（多架构/单架构都正确）。
function buildxDigest(ref) {
  return new Promise((resolve, reject) => {
    const args = ['-d', DISTRO, '-u', 'root', 'docker', 'buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'];
    execFile('wsl', args, { timeout: 25000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const m = ((stderr || stdout || err.message || '').toString()).trim();
        return reject(new Error(enhanceNetError(m || 'buildx imagetools inspect 失败')));
      }
      const raw = stdout.toString().trim();
      // 有些版本直接打印 sha256:... 字符串
      if (raw.startsWith('sha256:')) return resolve(raw);
      try {
        const p = JSON.parse(raw);
        // 关键：顶层 digest 字段（小写）才是引用对应的 digest。
        // 多架构 = 索引 digest，单架构 = manifest digest，均匹配本地 RepoDigests。
        const d = (p && (p.digest || p.Digest || (p.RepoDigests && p.RepoDigests[0])));
        if (typeof d === 'string' && d.startsWith('sha256:')) return resolve(d);
        return reject(new Error('buildx 输出中找不到 digest: ' + raw.slice(0, 200)));
      } catch (e) {
        reject(new Error('解析 buildx 输出失败: ' + e.message));
      }
    });
  });
}

// 遍历所有本地镜像，逐个 tag 比对本地 digest 与远端 digest，产出
// { checkedAt, byRef: { "<repo>:<tag>": { hasUpdate, localDigest, remoteDigest, error? } }, errors, total, checked }
// onProgress(detailMsg) 用于把进度推给后台任务日志。
async function checkImageUpdates(onProgress) {
  const cb = (typeof onProgress === 'function') ? onProgress : () => {};
  const byRef = {};
  const errors = {};
  let total = 0;
  let checked = 0;
  try {
    const imgs = await docker.listImages({ all: false });
    total = imgs.length;
    for (const im of imgs) {
      const refs = (im.RepoTags || []).filter((r) => r && r !== '<none>:<none>');
      if (!refs.length) { checked++; continue; }
      // 本地 digest：取 RepoDigests[0] 中 "@" 后的部分
      let localDigest = null;
      if (im.RepoDigests && im.RepoDigests.length) {
        const d = im.RepoDigests[0];
        localDigest = d.includes('@') ? d.split('@')[1] : d;
      }
      for (const ref of refs) {
        let remoteDigest = null;
        let lastErr = null;
        // 网络类错误（超时/不可达/连接被拒）常为间歇性，重试 2 次可自愈；其余错误不再重试。
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            remoteDigest = await inspectManifestDigest(ref);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (!/网络超时|网络不可达|连接被拒绝|连接被重置/.test(e.message)) break;
            if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
          }
        }
        if (lastErr && remoteDigest === null) {
          errors[ref] = lastErr.message;
          byRef[ref] = { hasUpdate: false, error: lastErr.message };
          cb(`检查 ${ref} 失败：${lastErr.message}`);
        } else {
          const hasUpdate = !!(localDigest && remoteDigest && localDigest !== remoteDigest);
          byRef[ref] = { hasUpdate, localDigest: localDigest || null, remoteDigest: remoteDigest || null };
          cb(`检查 ${ref}：${hasUpdate ? '发现新版本' : '已是最新'}`);
        }
      }
      checked++;
    }
  } catch (e) {
    errors._list = e.message;
    cb('读取镜像列表失败：' + e.message);
  }
  const data = { checkedAt: Date.now(), byRef, errors, total, checked };
  try {
    fs.mkdirSync(path.dirname(UPDATES_FILE), { recursive: true });
    fs.writeFileSync(UPDATES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    log.warn('写入镜像更新检测结果失败: ' + e.message);
  }
  return data;
}

// 读取上次检测结果（无则返回空结构）。
function getImageUpdates() {
  try {
    if (!fs.existsSync(UPDATES_FILE)) return { checkedAt: 0, byRef: {} };
    return JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8'));
  } catch (e) {
    return { checkedAt: 0, byRef: {}, error: e.message };
  }
}

// 镜像实际拉取 / 更新成功后，重新校准该引用的「可更新」缓存并持久化，
// 使「可更新」徽标在拉取成功后立即消失（否则要等下一次定时 / 手动检查才会更新）。
// 拉取成功后本地镜像即刚 pull 的版本，这里乐观清除标记并写入新本地 digest；
// 若 pull 命中了陈旧镜像（如镜像源缓存未刷新），下一次检查会重新标回，属可接受的权衡。
// image 可为 "repo:tag" 或 "repo@sha256:..." 形式。
async function revalidateImageUpdate(image) {
  try {
    const imgs = await docker.listImages({ all: false });
    const base = (image || '').split('@')[0];
    const im = (imgs || []).find((x) =>
      (x.RepoTags || []).some((t) => t === image || t === base || (base && t.startsWith(base + ':'))));
    const repoTag = (im && im.RepoTags && im.RepoTags[0]) || base || image;
    let localDigest = null;
    if (im && im.RepoDigests && im.RepoDigests.length) {
      const d = im.RepoDigests[0];
      localDigest = d.includes('@') ? d.split('@')[1] : d;
    }
    const entry = { hasUpdate: false, localDigest: localDigest || null, remoteDigest: null };
    const data = getImageUpdates();
    if (!data.byRef) data.byRef = {};
    data.byRef[repoTag] = entry;
    data.checkedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(UPDATES_FILE), { recursive: true });
      fs.writeFileSync(UPDATES_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) { /* 写缓存失败不影响主流程 */ }
    return entry;
  } catch (e) {
    return null;
  }
}

// Import an image tarball from a local file via the WSL docker CLI so that
// configured credentials/mirrors still apply. filePath is on the Windows host;
// winToWsl maps it into the WSL mount namespace (/mnt/d/...).
async function loadImageFromFile(filePath, onLine) {
  const { winToWsl } = require('./wsl');
  await wslDockerCmd(['load', '-i', winToWsl(filePath)], onLine || (() => {}));
  return { ok: true };
}

async function imageHistory(id) {
  return docker.getImage(id).history();
}

// ---------------------------------------------------------------------------
// runtime update (docker update, no recreate) + system + commit + network + build
// 卷备份/恢复 + .wslconfig 读写
// ---------------------------------------------------------------------------

// 实时修改容器运行时限制（CPU/内存/重启策略），无需删除重建容器。
// 支持的字段由 docker update 决定；未传的字段保持不变。
async function updateContainer(id, opts = {}) {
  const update = {};
  if (opts.cpuShares != null && opts.cpuShares !== '') update.CpuShares = Number(opts.cpuShares);
  if (opts.cpuQuota != null && opts.cpuQuota !== '') update.CpuQuota = Number(opts.cpuQuota);
  if (opts.cpuPeriod != null && opts.cpuPeriod !== '') update.CpuPeriod = Number(opts.cpuPeriod);
  if (opts.cpusetCpus != null && opts.cpusetCpus !== '') update.CpuSetCpus = String(opts.cpusetCpus);
  if (opts.memory != null && opts.memory !== '') update.Memory = Number(opts.memory);
  if (opts.memoryReservation != null && opts.memoryReservation !== '') update.MemoryReservation = Number(opts.memoryReservation);
  if (opts.memorySwap != null && opts.memorySwap !== '') update.MemorySwap = Number(opts.memorySwap);
  if (opts.restartPolicy) {
    update.RestartPolicy = { Name: opts.restartPolicy, MaximumRetryCount: opts.restartPolicy === 'on-failure' ? (Number(opts.maximumRetryCount) || 0) : 0 };
  }
  if (!Object.keys(update).length) throw new Error('没有任何可更新的字段');
  await docker.getContainer(id).update(update);
  return { ok: true, applied: update };
}

// docker system prune（统一清理：容器/镜像/网络/卷）。
async function systemPrune(opts = {}) {
  const args = ['system', 'prune', '-f'];
  if (opts.all) args.push('-a');
  if (opts.volumes) args.push('--volumes');
  await wslDockerCmd(args, () => {});
  return { ok: true };
}

// docker system df（磁盘占用分析）。
async function systemDf() {
  const r = await docker.df();
  return {
    layersSize: r.LayersSize || 0,
    images: (r.Images || []).map((x) => ({ id: x.Id, repoTags: x.RepoTags, size: x.Size, reclaimable: x.Reclaimable, sharedSize: x.SharedSize })),
    containers: (r.Containers || []).map((x) => ({ id: x.Id, size: x.Size, reclaimable: x.Reclaimable })),
    volumes: (r.Volumes || []).map((x) => ({ name: x.Name, size: x.Size, reclaimable: x.Reclaimable })),
    buildCache: (r.BuildCache || []).map((x) => ({ id: x.ID, type: x.Type, size: x.Size, reclaimable: x.Reclaimable })),
  };
}

// 将容器提交为新的镜像（docker commit）。
async function commitContainer(id, opts = {}) {
  const repo = (opts.repo || '').trim();
  const tag = (opts.tag || 'latest').trim() || 'latest';
  const created = await docker.getContainer(id).commit({
    repo: repo || undefined,
    tag: tag,
    comment: opts.message ? String(opts.message) : undefined,
    author: opts.author ? String(opts.author) : undefined,
    pause: opts.pause !== false,
  });
  return { id: created.id, shortId: created.id.slice(0, 12), ref: repo ? `${repo}:${tag}` : created.id };
}

// 将容器热插拔到网络（connect），或断开（disconnect）。
async function connectNetwork(netId, containerId, endpoint) {
  const body = { Container: containerId };
  if (endpoint && endpoint.Ipv4Address) body.EndpointConfig = { Ipv4Address: endpoint.Ipv4Address };
  await docker.getNetwork(netId).connect(body);
  return { ok: true };
}
async function disconnectNetwork(netId, containerId, force) {
  await docker.getNetwork(netId).disconnect({ Container: containerId, Force: !!force });
  return { ok: true };
}

// 从一段 Dockerfile 文本构建镜像。把 Dockerfile 写到临时目录，交由 WSL docker CLI 构建
// （这样构建上下文与 daemon.json 中的镜像源/代理一致）。
async function buildImageFromDockerfile({ dockerfile, tag, buildArgs }, onLine) {
  if (!dockerfile || !dockerfile.trim()) throw new Error('Dockerfile 内容不能为空');
  if (!tag || !tag.trim()) throw new Error('镜像标签(tag)不能为空');
  const { winToWsl } = require('./wsl');
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const dir = path.join(os.tmpdir(), 'wslmgr-build-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Dockerfile'), dockerfile, 'utf8');
  const wslDir = winToWsl(dir);
  const args = ['build', '-f', wslDir + '/Dockerfile', '-t', String(tag).trim()];
  const ba = buildArgs || {};
  for (const k of Object.keys(ba)) {
    const v = ba[k];
    if (v != null && String(v) !== '') args.push('--build-arg', `${k}=${v}`);
  }
  args.push(wslDir);
  await wslDockerCmd(args, onLine || (() => {}));
  return { ok: true, tag: String(tag).trim() };
}

// 卷备份：起一个 busybox 临时容器，把卷内容打包成 tar.gz 落到 Windows 临时目录。
async function backupVolume(name) {
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const { winToWsl } = require('./wsl');
  const outDir = path.join(os.tmpdir(), 'wslmgr-vol-' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, name + '.tar.gz');
  const wslDir = winToWsl(outDir);
  await wslDockerCmd([
    'run', '--rm',
    '-v', `${name}:/data`,
    '-v', `${wslDir}:/backup`,
    'busybox', 'tar', 'czf', `/backup/${name}.tar.gz`, '-C', '/data', '.',
  ], () => {});
  return outFile;
}

// 卷恢复：把上传的 tar.gz 解包回卷（先清空旧内容）。
async function restoreVolume(name, tarFile) {
  const { winToWsl } = require('./wsl');
  const path = require('path');
  const wslDir = winToWsl(path.dirname(tarFile));
  const fname = path.basename(tarFile);
  await wslDockerCmd([
    'run', '--rm',
    '-v', `${name}:/data`,
    '-v', `${wslDir}:/backup`,
    'busybox', 'sh', '-c', `rm -rf /data/* /data/.[!.]* ; tar xzf /backup/${fname} -C /data`,
  ], () => {});
  return { ok: true };
}

// 读取 %USERPROFILE%/.wslconfig，解析 [wsl2] 段内的常用字段。
function readWslConfig() {
  const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.wslconfig');
  const out = { exists: false, memory: '', processors: '', swap: '', swapFile: '', localhostForwarding: '', systemd: '' };
  try {
    if (!fs.existsSync(p)) return out;
    out.exists = true;
    let section = '';
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1).toLowerCase(); continue; }
      if (section !== 'wsl2') continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === 'memory') out.memory = v;
      else if (k === 'processors') out.processors = v;
      else if (k === 'swap') out.swap = v;
      else if (k === 'swapfile') out.swapFile = v;
      else if (k === 'localhostforwarding') out.localhostForwarding = v;
      else if (k === 'systemd') out.systemd = v;
    }
  } catch (e) { out.error = e.message; }
  return out;
}

// 写回 .wslconfig（仅覆盖已知字段，保留其它段与注释）。
function writeWslConfig(patch) {
  const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.wslconfig');
  let lines = [];
  const known = { memory: '', processors: '', swap: '', swapfile: '', localhostforwarding: '', systemd: '' };
  const values = Object.assign({}, known);
  for (const k in patch) {
    if (k in values) values[k] = String(patch[k] || '').trim();
  }
  try {
    if (fs.existsSync(p)) lines = fs.readFileSync(p, 'utf8').split('\n');
  } catch (e) { lines = []; }
  const cleaned = [];
  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1).toLowerCase(); cleaned.push(raw); continue; }
    if (section === 'wsl2' && line.indexOf('=') >= 0) {
      const k = line.slice(0, line.indexOf('=')).trim().toLowerCase();
      if (k in values) continue;
    }
    cleaned.push(raw);
  }
  let insertAt = cleaned.length;
  let hadWsl2 = false;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i].trim().toLowerCase() === '[wsl2]') { hadWsl2 = true; insertAt = i + 1; }
  }
  const block = [];
  for (const k of Object.keys(values)) {
    if (values[k]) block.push(`${k}=${values[k]}`);
  }
  if (block.length) {
    if (!hadWsl2) { cleaned.push('[wsl2]'); cleaned.push(...block); }
    else { cleaned.splice(insertAt, 0, ...block); }
  }
  fs.writeFileSync(p, cleaned.join('\n').replace(/\n+$/, '') + '\n', 'utf8');
  return { ok: true, path: p };
}

module.exports = {
  docker,
  Docker,
  withTimeout,
  ping,
  getInfo,
  getVersion,
  // containers
  listContainers,
  inspectContainer,
  startContainer,
  stopContainer,
  restartContainer,
  killContainer,
  pauseContainer,
  unpauseContainer,
  removeContainer,
  containerStats,
  containerStatsBatch,
  containerLogs,
  createContainer,
  execInContainer,
  updateContainerImage,
  recreateContainer,
  // images
  listImages,
  inspectImage,
  removeImage,
  pruneImages,
  tagImage,
  pushImage,
  pullImage,
  imageHistory,
  // volumes
  listVolumes,
  inspectVolume,
  removeVolume,
  pruneVolumes,
  createVolume,
  // networks
  listNetworks,
  inspectNetwork,
  removeNetwork,
  pruneNetworks,
  createNetwork,
  // host
  getWslResources,
  getOverview,
  // engine management
  updateDockerEngine,
  // registry login
  loginRegistry,
  listRegistries,
  logoutRegistry,
  // runtime / system / commit / network / build / volume / wslconfig
  updateContainer,
  systemPrune,
  systemDf,
  commitContainer,
  connectNetwork,
  disconnectNetwork,
  buildImageFromDockerfile,
  backupVolume,
  restoreVolume,
  readWslConfig,
  writeWslConfig,
  // P0 additions
  renameContainer,
  pruneContainers,
  loadImageFromFile,
  // auto-restore (start WSL → docker → previously-running containers)
  snapshotRunningContainers,
  restoreRunningContainers,
  // 镜像更新检测
  checkImageUpdates,
  getImageUpdates,
  revalidateImageUpdate,
};
