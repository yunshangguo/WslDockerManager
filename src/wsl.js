// WSL2 helpers: run commands inside the distro, and translate Windows <-> WSL paths.
// Used for (a) ensuring dockerd is up, and (b) running `docker compose` inside WSL
// (dockerode has weak compose support, so we shell out to the in-WSL plugin).
const { execFile, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const log = require('./logger');

const DISTRO = cfg.distro;

// 解析 wsl.exe 的真实路径，避免依赖后端进程的 PATH（服务/Electron 外壳/启动器
// 常常带有被裁剪的 PATH，导致 execFile('wsl') 报 ENOENT，从而误报 WSL/Debian
// “未安装”）。优先用 System32 规范路径，32 位进程下再退回 Sysnative。
function resolveWslExe() {
  const sr = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(sr, 'System32', 'wsl.exe'),
    path.join(sr, 'Sysnative', 'wsl.exe'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return 'wsl.exe'; // 兜底：仍依赖 PATH
}
const WSL_EXE = resolveWslExe();

// wsl.exe 经管道输出时，编码不确定：可能是 UTF-8（带/不带 BOM）或 UTF-16LE
// （无 BOM）。若直接用 toString('utf8') 解码 UTF-16LE，'Debian' 等文本会乱码，
// 导致发行版名称匹配失败、误报“未找到 Debian 发行版”。这里做健壮解码：
//   1) UTF-16LE BOM (FF FE) → utf16le
//   2) UTF-8 BOM (EF BB BF) → 去掉 BOM 后 utf8
//   3) UTF-16LE 无 BOM：长度偶数且奇数位字节绝大多数为 0x00（ASCII 文本在
//      UTF-16LE 下正是此特征；而 UTF-8 中文极少出现此结构）→ 按 utf16le 解码
//   4) 兜底 utf8
function decodeWslOutput(out) {
  if (out == null) return '';
  let buf = Buffer.isBuffer(out) ? out : Buffer.from(String(out), 'utf8');
  try {
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      return buf.slice(2).toString('utf16le');
    }
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      return buf.slice(3).toString('utf8');
    }
    if (buf.length >= 2 && buf.length % 2 === 0) {
      let zeros = 0;
      for (let i = 1; i < buf.length; i += 2) if (buf[i] === 0x00) zeros++;
      if (zeros / (buf.length / 2) >= 0.8) return buf.toString('utf16le');
    }
    let s = buf.toString('utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // 去掉可能的 UTF-8 BOM（char 形式）
    return s;
  } catch (_) {
    return String(out);
  }
}

// Windows path (D:\foo\bar) -> WSL path (/mnt/d/foo/bar)
function winToWsl(winPath) {
  if (!winPath) return winPath;
  let p = winPath.replace(/\\/g, '/');
  return p.replace(/^([A-Za-z]):/, (_, d) => '/mnt/' + d.toLowerCase());
}

// WSL path (/mnt/d/foo/bar) -> Windows path (D:\foo\bar)
function wslToWin(wslPath) {
  if (!wslPath) return wslPath;
  return wslPath.replace(/^\/mnt\/([a-z])\//, (_, d) => d.toUpperCase() + ':\\').replace(/\//g, '\\');
}

// Run a command as root inside the WSL distro. Returns stdout (trimmed).
// opts.timeout default 60s; set higher for big compose pulls.
function runWsl(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-d', DISTRO, '-u', 'root', ...args];
    execFile(WSL_EXE, fullArgs, { timeout: opts.timeout || 60000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const out = decodeWslOutput(stdout).trim();
        const errMsg = decodeWslOutput(stderr).trim();
        const detail = `${errMsg || ''}${errMsg && out ? ' | ' : ''}${out || ''}${err && err.message && !errMsg ? ' | ' + err.message : ''}`;
        return reject(new Error(detail || `wsl ${args.join(' ')} failed`));
      }
      resolve(decodeWslOutput(stdout).trim());
    });
  });
}

// Run a bare `wsl <args>` WITHOUT the distro/user prefix (e.g. `wsl -l -v`).
function runWslRaw(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(WSL_EXE, args, { timeout: opts.timeout || 60000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const out = decodeWslOutput(stdout).trim();
        const errMsg = decodeWslOutput(stderr).trim();
        const detail = `${errMsg || ''}${errMsg && out ? ' | ' : ''}${out || ''}${err && err.message && !errMsg ? ' | ' + err.message : ''}`;
        return reject(new Error(detail || `wsl ${args.join(' ')} failed`));
      }
      resolve(decodeWslOutput(stdout).trim());
    });
  });
}

// ---- dockerd health / startup ----

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Probe whether dockerd is ACTUALLY serving on the TCP port, from the Windows
// side. We do a real HTTP GET /_ping (exactly what dockerode does) instead of a
// bare TCP connect: on some WSL/Windows setups a TCP SYN to 127.0.0.1:2375 is
// "accepted" by the loopback layer even when no dockerd is listening, which
// makes a raw connect() report success while dockerode's actual request fails
// with ECONNREFUSED. The HTTP check matches dockerode's real behavior.
function dockerdTcpUp(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: cfg.dockerHost, port: cfg.dockerPort, path: '/_ping', timeout: timeoutMs },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(res.statusCode === 200));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
  });
}

// Whether a dockerd process is currently running inside WSL, regardless of
// whether it has bound 2375 yet. Used so we don't kill a dockerd that is merely
// still starting up when we only observed a transient /_ping failure.
async function dockerdProcessUp() {
  try {
    const out = await runWsl(['bash', '-c', 'pgrep -x dockerd >/dev/null 2>&1 && echo yes || echo no']);
    return /yes/.test(out);
  } catch (_) { return false; }
}

// Idempotently write the systemd drop-in so `systemctl start docker` binds 2375.
async function writeDockerOverride() {
  const dir = '/etc/systemd/system/docker.service.d';
  const conf = `${dir}/override.conf`;
  // Restart=always makes systemd auto-recover a crashed dockerd within ~2s
  // instead of leaving it dead (which forced the app to restart it on every
  // health tick and killed all running containers in the process).
  const body = '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock\nRestart=always\nRestartSec=2\n';
  const cmd = `mkdir -p ${dir} && cat > ${conf} <<'WSLEOF'\n${body}WSLEOF`;
  await runWsl(['bash', '-c', cmd]);
}

// Enable systemd for future WSL boots (takes effect after `wsl --shutdown`).
async function ensureSystemdEnabled() {
  const conf = '/etc/wsl.conf';
  const cur = await runWsl(['bash', '-c', `cat ${conf} 2>/dev/null || true`]).catch(() => '');
  if (/^\s*systemd\s*=\s*true/im.test(cur)) return;
  const add = (cur ? cur.replace(/\s*$/, '') + '\n' : '') + '[boot]\nsystemd=true\n';
  const cmd = `cat > ${conf} <<'WSLEOF'\n${add}WSLEOF`;
  await runWsl(['bash', '-c', cmd]).catch(() => {});
  log.warn('已写入 /etc/wsl.conf 启用 systemd；建议择机执行 wsl --shutdown 让其生效');
}

// Last-resort: start dockerd directly with the TCP listener. Covers WSL distros
// where systemd is NOT PID 1, so the service/script path never binds 2375.
// `service docker start` first brings up containerd, then we replace the
// socket-only dockerd with one that also listens on 2375.
async function startDockerdDirect() {
  await runWsl(['bash', '-c', 'service docker start 2>/dev/null; pkill -x dockerd 2>/dev/null; sleep 2; true']);
  await runWsl(['bash', '-c', 'nohup dockerd -H fd:// -H tcp://127.0.0.1:2375 --iptables=false >/var/log/dockerd-tcp.log 2>&1 &']);
  await sleep(5000);
  return dockerdTcpUp();
}

// Ensure dockerd is running inside WSL AND bound to the TCP port. If not, start it.
// Uses systemd when available (with the 2375 override), else starts dockerd directly.
// Returns true ONLY when dockerd is actually serving on 127.0.0.1:2375.
// `force` (passed when dockerode's own ping just failed) skips the quick
// "already up?" short-circuit and always attempts a restart - this breaks the
// rapid flap where a bare TCP/HTTP check catches a transient up-moment.
async function ensureDockerd(force = false) {
  // 1) Boot the WSL distro (cold-start if it was shut down by sleep/hibernation/
  //    `wsl --shutdown`). A bare echo launches the distro and returns immediately.
  try {
    await runWsl(['echo', '__wsl_up__']);
  } catch (e) {
    log.error(`WSL 发行版无法启动（${DISTRO}）: ${e.message}`);
    // surface diagnostic context so the real cause is visible in the log
    try {
      const ls = await runWslRaw(['-l', '-v']);
      log.error(`wsl -l -v:\n${ls}`);
    } catch (e2) {
      log.error(`wsl -l -v 也失败: ${e2.message}`);
    }
    return false;
  }

  // Ensure the systemd override (Restart=always + tcp://2375) is always in place,
  // even when docker is healthy - so a fresh install / config change is picked up
  // on the next down->up cycle. Cheap and idempotent.
  await writeDockerOverride().catch(() => {});

  // Already bound to 2375 and not forced? Then nothing to do (no restart, no churn).
  // This short-circuit is what stops the old self-inflicted restart storm: a
  // transient /_ping blip will NOT trigger a `systemctl restart docker` here.
  if (!force && await dockerdTcpUp()) {
    try { await runWsl(['systemctl', 'enable', 'docker']); } catch (_) {}
    return true;
  }
  log.warn('dockerd 未在 127.0.0.1:2375 稳定监听，尝试拉起...');

  // 2) Is systemd the init?
  let usesSystemd = false;
  try {
    const out = await runWsl(['bash', '-c', '[ -d /run/systemd/system ] && echo yes || echo no']);
    usesSystemd = /yes/.test(out);
  } catch (_) {}

  if (usesSystemd) {
    // Avoid docker.socket socket-activation competing with our explicit
    // -H tcp://127.0.0.1:2375 ExecStart (a race that can crash dockerd on boot).
    await runWsl(['systemctl', 'disable', 'docker.socket']).catch(() => {});
    await runWsl(['systemctl', 'daemon-reload']).catch(() => {});
    await runWsl(['systemctl', 'enable', 'docker']).catch(() => {});
    const up = await dockerdTcpUp();
    const proc = await dockerdProcessUp();
    if (!up && !proc) {
      // No dockerd running at all -> start it (Restart=always in the override
      // makes systemd auto-recover future crashes without us killing containers).
      try { await runWsl(['systemctl', 'restart', 'docker']); } catch (_) {}
    }
    // Poll up to ~15s. If a dockerd process is already running but not yet on
    // 2375 we just wait (don't kill it) - it'll bind on its own.
    for (let i = 0; i < 6; i++) {
      await sleep(2500);
      if (await dockerdTcpUp()) {
        log.info('dockerd 已在 WSL 内启动（systemd，监听 2375，已设 Restart=always）');
        return true;
      }
    }
  }

  // 3) Non-systemd (or systemd failed to bind 2375): start dockerd directly.
  try {
    if (await startDockerdDirect()) { log.info('dockerd 已直接以 tcp://127.0.0.1:2375 启动'); return true; }
  } catch (e) {
    log.error(`直接启动 dockerd 失败: ${e.message}`);
  }

  // 4) Legacy service fallback (some distros bind 2375 via the default script).
  try {
    await runWsl(['service', 'docker', 'start']);
    await sleep(4000);
    if (await dockerdTcpUp()) { log.info('docker 已通过 service 命令启动'); return true; }
  } catch (_) {}

  await ensureSystemdEnabled().catch(() => {});
  log.error('无法让 dockerd 在 127.0.0.1:2375 监听；请检查 WSL/Debian 内 docker 安装');
  return false;
}

// Run `docker compose` inside WSL with the given args. cwd optional Windows dir.
async function dockerCompose(args, opts = {}) {
  const cmd = ['docker', 'compose', ...args];
  if (opts.cwd) {
    const wslCwd = winToWsl(opts.cwd);
    return runWsl(['bash', '-c', `cd "${wslCwd}" && ${cmd.map(quote).join(' ')}`], opts);
  }
  return runWsl(cmd, opts);
}

function quote(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// 连接诊断：当系统"连接不到 Linux / Docker"时，逐级排查原因，给出结构化结论。
// 关键点：诊断本身不依赖 docker TCP（那正是失败点），而是用 wsl CLI 逐层探活：
//   1) WSL 是否安装（wsl -l -v 能否执行）
//   2) 目标发行版（Debian）是否安装
//   3) 发行版是否在运行（wsl -d <d> echo 能否执行）
//   4) WSL 内是否安装了 docker
//   5) dockerd 进程是否存在
//   6) dockerd 是否监听 127.0.0.1:2375（Windows 侧 localhost 转发）
//   7) 经 TCP 端口的 Docker API 是否可达
// 结论 status ∈ { ok, wsl_missing, distro_missing, distro_not_running,
//                 docker_not_installed, dockerd_down, network_issue }
// ---------------------------------------------------------------------------

// 读取 %USERPROFILE%/.wslconfig 中 [wsl2] 段的 localhostForwarding 值（用于"网络设置"类判断）。
function readLocalhostForwarding() {
  try {
    const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.wslconfig');
    if (!fs.existsSync(p)) return null;
    let section = '';
    for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1).toLowerCase(); continue; }
      if (section !== 'wsl2') continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      if (line.slice(0, i).trim().toLowerCase() === 'localhostforwarding') return line.slice(i + 1).trim();
    }
  } catch (e) { /* ignore */ }
  return null;
}

// 经 TCP 端口直连 dockerd 验证 API 可用性（与 dockerode 走同一通道）。
async function dockerApiTcpReachable() {
  const args = ['-d', DISTRO, '-u', 'root', 'docker', '-H', `tcp://${cfg.dockerHost}:${cfg.dockerPort}`, 'version', '--format', '{{.Server.Version}}'];
  try {
    const out = await runWsl(args, { timeout: 8000 });
    return { ok: !!(out || '').trim(), detail: (out || '').trim() || '版本为空' };
  } catch (e) {
    return { ok: false, detail: (e.message || '').slice(0, 200) };
  }
}

async function diagnoseConnection() {
  const steps = [];
  const hints = [];
  let status = 'ok';
  const fail = (s) => { if (status === 'ok') status = s; };

  // 1) WSL 是否安装
  let wslList = '';
  let wslInstalled = false;
  try {
    wslList = await runWslRaw(['-l', '-v'], { timeout: 15000 });
    wslInstalled = true;
  } catch (e) {
    const m = e.message || '';
    // 已装 WSL 但无发行版时，wsl -l -v 也可能以非 0 退出；这种不算"没装 WSL"。
    if (/no installed distributions|未安装任何发行版|没有已安装|未找到分发/i.test(m)) {
      wslInstalled = true;
      wslList = '';
    } else {
      steps.push({
        name: 'WSL 已安装',
        ok: false,
        detail: /ENOENT|not recognized|不是内部或外部命令|command not found/i.test(m)
          ? '未检测到 wsl 命令，可能尚未安装 WSL。'
          : 'wsl -l -v 执行失败：' + m.slice(0, 200),
      });
      fail('wsl_missing');
      hints.push('请先安装 WSL2：以管理员身份打开 PowerShell，执行 `wsl --install`，按提示重启后，再运行本项目 install/setup-wsl-docker.ps1。');
      return { ok: false, status, steps, hints };
    }
  }
  if (wslInstalled) {
    steps.push({ name: 'WSL 已安装', ok: true, detail: (wslList.split('\n').filter(Boolean).slice(0, 2).join(' ').trim() || 'wsl 命令可用') });

    // 2) 目标发行版是否存在
    const hasDistro = new RegExp('\\b' + DISTRO + '\\b').test(wslList);
    if (!hasDistro) {
      steps.push({ name: `已安装 ${DISTRO} 发行版`, ok: false, detail: '未找到 ' + DISTRO + ' 发行版。' });
      fail('distro_missing');
      hints.push(`请安装 ${DISTRO} 发行版：运行项目 install/setup-wsl-docker.ps1（第 1 步会自动安装），或执行 \`wsl --install -d ${DISTRO}\`。`);
      return { ok: false, status, steps, hints };
    }
    steps.push({ name: `已安装 ${DISTRO} 发行版`, ok: true, detail: DISTRO + ' 已安装' });

    // 3) 发行版是否在运行（runWsl 会冷启动发行版，若它无法启动才失败）
    let distroUp = true;
    try {
      await runWsl(['echo', '__up__'], { timeout: 20000 });
    } catch (e) {
      distroUp = false;
      steps.push({ name: `${DISTRO} 可正常启动`, ok: false, detail: '在 WSL 内执行命令失败：' + (e.message || '').slice(0, 200) });
      fail('distro_not_running');
      hints.push(`WSL 发行版未能启动：可尝试 \`wsl --shutdown\` 后重新打开；若提示 WSL 组件损坏，用 \`wsl --unregister ${DISTRO}\` 注销后重装 ${DISTRO}。`);
      return { ok: false, status, steps, hints };
    }
    steps.push({ name: `${DISTRO} 可正常启动`, ok: true, detail: 'WSL 实例可正常执行命令' });

    // 4) WSL 内是否安装了 docker
    let dockerInstalled = true;
    try {
      const v = await runWsl(['docker', '--version'], { timeout: 20000 });
      steps.push({ name: 'Docker 已安装', ok: true, detail: (v || '').trim() });
    } catch (e) {
      dockerInstalled = false;
      steps.push({ name: 'Docker 已安装', ok: false, detail: 'WSL 内未找到 docker：' + (e.message || '').slice(0, 200) });
      fail('docker_not_installed');
      hints.push('WSL 内尚未安装 Docker：运行 install/setup-wsl-docker.ps1 会自动完成安装（含 daemon 监听 2375 与开机自启）。');
      return { ok: false, status, steps, hints };
    }

    if (dockerInstalled) {
      // 5) dockerd 进程是否存在
      const procUp = await dockerdProcessUp().catch(() => false);
      const portUp = await dockerdTcpUp(3000).catch(() => false);
      if (!procUp) {
        steps.push({ name: 'Docker 守护进程(dockerd)运行中', ok: false, detail: 'dockerd 进程未运行。' });
        fail('dockerd_down');
        hints.push('Docker 守护进程未启动：在 WSL 内执行 `sudo systemctl start docker`，或 `wsl --shutdown` 后重启 ' + DISTRO + '（本程序也会自动尝试拉起）。');
      } else {
        steps.push({ name: 'Docker 守护进程(dockerd)运行中', ok: true, detail: 'dockerd 进程存在' });
        if (!portUp) {
          steps.push({ name: 'dockerd 监听 127.0.0.1:2375', ok: false, detail: 'dockerd 已运行，但未在 127.0.0.1:2375 监听（Windows 侧无法经 localhost 访问）。' });
          fail('network_issue');
          const fwd = readLocalhostForwarding();
          if (fwd && /false/i.test(fwd)) {
            hints.push('.wslconfig 中 localhostForwarding=false 会阻止 Windows 经 localhost 访问 WSL 服务，请改为 true 并重启 WSL（`wsl --shutdown`）。');
          }
          hints.push('dockerd 未监听 TCP 2375：确认 /etc/systemd/system/docker.service.d/override.conf 含 `-H tcp://127.0.0.1:2375`，并重跑 install/setup-wsl-docker.ps1 写入该覆盖；也可在 WSL 内 `sudo systemctl restart docker`。');
        } else {
          steps.push({ name: 'dockerd 监听 127.0.0.1:2375', ok: true, detail: '127.0.0.1:2375 可访问' });
          // 7) 经 TCP 的 Docker API 是否可达（与 dockerode 同通道）
          const apiOk = await dockerApiTcpReachable();
          if (apiOk.ok) {
            steps.push({ name: 'Docker API(tcp://127.0.0.1:2375)可达', ok: true, detail: 'docker version 调用成功（' + apiOk.detail + '）' });
          } else {
            steps.push({ name: 'Docker API(tcp://127.0.0.1:2375)可达', ok: false, detail: '端口可达但 API 调用失败：' + apiOk.detail });
            fail('network_issue');
            hints.push('dockerd 端口可达但 API 调用失败：多为瞬时抖动，点「重启 Docker」或刷新后重试。');
          }
        }
      }

      // 即便目前可达，也提示潜在的网络设置风险（localhostForwarding=false）
      const fwd2 = readLocalhostForwarding();
      if (fwd2 && /false/i.test(fwd2) && status === 'ok') {
        hints.push('提示：.wslconfig 中 localhostForwarding=false，当前虽仍可访问，但稳定性风险高，建议改为 true。');
      }
    }
  }

  return { ok: status === 'ok', status, steps, hints };
}

// ---- WSL keep-alive ----
// WSL2 auto-terminates an idle distro after a while unless a Windows-side `wsl`
// process is actively holding the instance open. systemd / dockerd background
// daemons alone are NOT a reliable hedge - WSL still suspends idle distros in
// many configs, which then makes dockerd unreachable (ECONNREFUSED 2375) and
// kills every running container. To prevent that we spawn a persistent
// `wsl -d <distro> -u root sleep infinity` child from the backend: as long as
// that process lives, the distro - and therefore dockerd - stays awake. The
// install-time scheduled task `WslDockerKeepAlive` provides the SAME guarantee
// when the app itself is closed (or before login), so together they keep
// Docker + Linux alive "after install" exactly as required.
let keepAliveProc = null;
let keepAliveStopping = false;
let keepAliveTimer = null;

function startWslKeepAlive() {
  if (keepAliveProc || keepAliveStopping) return;
  keepAliveStopping = false;
  log.info('启动 WSL keep-alive 保活进程（防止 Debian 发行版被自动休眠）...');
  const child = spawn(WSL_EXE, ['-d', DISTRO, '-u', 'root', 'sleep', 'infinity'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  keepAliveProc = child;
  child.on('error', (e) => {
    keepAliveProc = null;
    if (keepAliveStopping) return;
    log.error('WSL keep-alive 启动失败: ' + e.message + '；10s 后重试');
    if (!keepAliveTimer) keepAliveTimer = setTimeout(() => startWslKeepAlive(), 10000);
  });
  child.on('exit', (code, signal) => {
    keepAliveProc = null;
    if (keepAliveStopping) return;
    log.warn('WSL keep-alive 进程退出（code=' + code + ' signal=' + signal + '），10s 后重拉...');
    if (keepAliveTimer) clearTimeout(keepAliveTimer);
    keepAliveTimer = setTimeout(() => startWslKeepAlive(), 10000);
  });
}

function stopWslKeepAlive() {
  keepAliveStopping = true;
  if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
  if (keepAliveProc) { try { keepAliveProc.kill(); } catch (_) {} keepAliveProc = null; }
}

module.exports = { winToWsl, wslToWin, runWsl, runWslRaw, ensureDockerd, dockerCompose, startWslKeepAlive, stopWslKeepAlive, diagnoseConnection, DISTRO, WSL_EXE };
