// 环境前置依赖检测与一键安装。
// 项目启动时应能回答：虚拟化开了没？WSL 装了没？Debian 装了没？Docker 最新版装了没？
// 还有其他必要设置（.wslconfig / DOCKER_HOST / 2375 覆盖 / 保活任务）是否就绪？
// 任一/全部缺失时，可由本项目触发安装并自动完成环境配置（通过提权运行安装脚本）。
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const { runWsl, runWslRaw, DISTRO, WSL_EXE } = require('./wsl');
const WSL_EXE_RESOLVED = WSL_EXE;

// ---- low-level exec helpers (never throw; return structured result) ----
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 25000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').toString().trim(), stderr: (stderr || '').toString().trim(), err: err ? err.message : null });
    });
  });
}
const ps = (expr) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', expr]);
const sh = (cmd, args, opts) => run(cmd, args, opts);

// 进程级短时缓存：同一轮检测里多处用到 `wsl --version` / `wsl -l -v` 时复用同一个
// 进程结果（同时合并并发调用），显著降低 wsl.exe 并发拉起数量。WSL 对并发实例会
// 串行化，这正是整轮检测被拖到 ~4s 的主因。2s TTL 足以覆盖单次 checkPrerequisites。
let _wslVer = { at: 0, p: null };
function wslVersionRaw() {
  const now = Date.now();
  if (_wslVer.p && now - _wslVer.at < 2000) return _wslVer.p;
  const p = runWslRaw(['--version'], { timeout: 15000 }).catch((e) => { _wslVer.p = null; throw e; });
  _wslVer = { at: now, p };
  return p;
}
let _wslListV = { at: 0, p: null };
function wslListV() {
  const now = Date.now();
  if (_wslListV.p && now - _wslListV.at < 2000) return _wslListV.p;
  const p = runWslRaw(['-l', '-v'], { timeout: 15000 }).catch((e) => { _wslListV.p = null; throw e; });
  _wslListV = { at: now, p };
  return p;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 当前进程是否为 Windows 管理员（决定是否走 UAC 提权）。
function isAdmin() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))'], { timeout: 15000, windowsHide: true });
    return /true/i.test(out.toString());
  } catch (_) { return false; }
}

// ===========================================================================
//  逐项检测
// ===========================================================================

// 1) 虚拟化（固件 VT-x/AMD-V + Windows 虚拟机平台功能）
async function checkVirtualization() {
  const c = { key: 'virtualization', label: 'CPU 虚拟化已开启(VT-x/AMD-V + 虚拟机平台)', ok: false, status: 'unknown', detail: '', fix: '请在 BIOS/UEFI 中开启 CPU 虚拟化（Intel VT-x / AMD-V），并启用 Windows“虚拟机平台”功能。' };
  try {
    // 合并为一次 PowerShell 调用（原两次串行 powershell.exe 进程）
    const out = await ps("(Get-CimInstance Win32_ComputerSystem).HypervisorPresent; try { (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform).State } catch { 'unknown' }");
    const lines = out.stdout.split(/\r?\n/).map((s) => s.trim());
    const hypervisor = /true/i.test(lines[0] || '');
    let vmp = 'unknown';
    const vmpLine = lines.slice(1).join(' ');
    if (/enabled/i.test(vmpLine)) vmp = 'enabled';
    else if (/disabled/i.test(vmpLine)) vmp = 'disabled';
    if (hypervisor) {
      if (vmp === 'enabled' || vmp === 'unknown') { c.ok = true; c.status = 'ok'; c.detail = vmp === 'unknown' ? '已检测到 Hypervisor（虚拟化已开启）' : '虚拟化已开启且“虚拟机平台”功能已启用'; }
      else { c.ok = false; c.status = 'missing'; c.detail = '固件虚拟化已开启，但 Windows“虚拟机平台”功能未启用'; }
    } else {
      c.ok = false; c.status = 'missing'; c.detail = '未检测到 Hypervisor：BIOS/UEFI 中未开启 CPU 虚拟化';
    }
  } catch (e) { c.detail = '检测失败：' + e.message; }
  return c;
}

// 2) WSL2 已安装
// 关键修复：① 不再只靠 `wsl --version`（旧版 in-box WSL 不支持该参数，会直接
//   报错被误判为“未安装”）；改用 `wsl -l -v` 兜底确认。② 真正的“未安装”只在其
//   他命令也确认 wsl.exe 不可用时才判定为 missing，否则归为 unknown 并附带真实错误。
async function checkWsl() {
  const c = { key: 'wsl', label: 'WSL2 已安装', ok: false, status: 'unknown', detail: '', fix: '以管理员 PowerShell 运行 `wsl --install` 后重启。' };
  try {
    c.extra = WSL_EXE_RESOLVED;
    // 优先 --version（现代 WSL）
    let ver = '';
    try { ver = (await wslVersionRaw()).trim(); } catch (_) {}
    if (/WSL version/i.test(ver) || /\d+\.\d+/.test(ver)) {
      const line = ver.split('\n').find((l) => /WSL version/i.test(l));
      c.ok = true; c.status = 'ok';
      c.detail = (line || 'WSL 已安装').trim() + '（' + WSL_EXE_RESOLVED + '）';
      return c;
    }
    // 退回 -l -v（旧版 WSL 也支持）。能列出即说明 WSL 已装。
    let list = '';
    try { list = (await wslListV()).trim(); }
    catch (e) {
      const m = e.message || '';
      if (/no installed distributions|未安装任何发行版|没有已安装|未找到分发/i.test(m)) {
        c.ok = true; c.status = 'ok'; c.detail = 'WSL 已安装（尚未安装任何发行版）（' + WSL_EXE_RESOLVED + '）';
        return c;
      }
      if (/ENOENT|not recognized|不是内部或外部命令|command not found/i.test(m)) {
        c.status = 'missing';
        c.detail = '未检测到 wsl 命令（WSL 未安装，或后端进程 PATH 中找不到 wsl.exe）：' + m.slice(0, 140);
      } else {
        c.status = 'unknown';
        c.detail = 'wsl -l -v 执行失败：' + m.slice(0, 200);
      }
      return c;
    }
    if (list) {
      c.ok = true; c.status = 'ok';
      c.detail = 'WSL 已安装（' + WSL_EXE_RESOLVED + '；`--version` 不可用，已用 -l -v 确认）';
    } else {
      c.status = 'unknown';
      c.detail = 'wsl --version 与 wsl -l -v 均无有效输出';
    }
  } catch (e) { c.detail = '检测失败：' + (e.message || '').slice(0, 160); }
  return c;
}

// 3) Debian 发行版已安装
// 健壮匹配：wsl -l -v 输出编码不定（UTF-8/UTF-16LE/BOM），且发行版注册名可能是
// "Debian" / "Debian GNU/Linux" 等。统一做：去控制字符 → 转小写 → 子串包含
// "debian"（大小写不敏感），并先用 -l -v、再用 -l -q 兜底，最大化正确识别。
function normWslList(s) {
  return (s || '').replace(/[^\x20-\x7E]/g, ' ').toLowerCase();
}
function debianInList(s) {
  const n = normWslList(s);
  return n.includes('debian');
}
async function checkDebian() {
  const c = { key: 'debian', label: `${DISTRO} 发行版已安装`, ok: false, status: 'unknown', detail: '', fix: `运行 \`wsl --install -d ${DISTRO}\` 安装发行版。` };
  let list = '';
  let rawList = '';
  try { list = await wslListV(); rawList = list; }
  catch (e) {
    const m = e.message || '';
    if (/no installed distributions|未安装任何发行版|没有已安装|未找到分发/i.test(m)) {
      c.status = 'missing'; c.detail = 'WSL 已安装但未安装任何发行版（含 ' + DISTRO + '）';
      return c;
    }
    if (/ENOENT|not recognized|不是内部或外部命令|command not found/i.test(m)) {
      c.status = 'missing'; c.detail = '未检测到 wsl 命令（WSL 未安装）';
      return c;
    }
    // 其它错误：再试 -l -q（仅列名称，更稳）
    try { list = await runWslRaw(['-l', '-q'], { timeout: 15000 }); rawList = list; }
    catch (e2) {
      c.status = 'unknown';
      c.detail = 'wsl -l -v / -l -q 均失败：' + (e2.message || m).slice(0, 200);
      return c;
    }
  }
  // 若 -l -v 未匹配，再用 -l -q 兜底
  let found = debianInList(list);
  if (!found) {
    try {
      const q = await runWslRaw(['-l', '-q'], { timeout: 15000 });
      rawList = rawList ? rawList + '\n---\n' + q : q;
      found = debianInList(q);
    } catch (_) {}
  }
  if (found) {
    c.ok = true; c.status = 'ok';
    let vers = '';
    try { vers = (await runWsl(['bash', '-c', 'cat /etc/debian_version 2>/dev/null || echo'])).trim(); } catch (_) {}
    c.detail = DISTRO + ' 已安装' + (vers ? '（Debian ' + vers + '）' : '');
    c.extra = vers;
  } else {
    c.status = 'missing';
    c.detail = 'WSL 已安装，但在已注册发行版列表中未识别到 ' + DISTRO + '。已识别列表：' + (normWslList(rawList).replace(/\s+/g, ' ').trim().slice(0, 160) || '(空)');
  }
  return c;
}

// 4) Docker 引擎已安装（含是否最新版）
async function dockerLatestVersion() {
  try {
    const out = await runWsl(['bash', '-c', "apt-cache policy docker-ce 2>/dev/null | grep -E 'Installed|Candidate'; apt-cache policy docker.io 2>/dev/null | grep -E 'Installed|Candidate'"], { timeout: 15000 });
    const inst = (out.match(/Installed:\s*([^\n]+)/) || [])[1];
    const cand = (out.match(/Candidate:\s*([^\n]+)/) || [])[1];
    return { installed: (inst || '').trim(), candidate: (cand || '').trim() };
  } catch (_) { return null; }
}
async function checkDocker() {
  const c = { key: 'docker', label: 'Docker 引擎已安装', ok: false, status: 'missing', detail: '', fix: '在“环境检测”页点“一键安装并自动配置”即可在 WSL 内安装 Docker。' };
  try {
    const v = (await runWsl(['docker', '--version'], { timeout: 20000 })).trim();
    c.ok = true;
    c.version = v.replace(/Docker version /, '').trim();
    c.detail = v;
    const latest = await dockerLatestVersion();
    if (latest && latest.installed && /none/i.test(latest.installed)) {
      c.status = 'missing'; c.ok = false; c.detail = '未检测到 docker 包（apt 仓库可能未配置）';
    } else if (latest && latest.installed && latest.candidate && latest.installed !== latest.candidate) {
      c.status = 'outdated'; c.ok = false;
      c.detail += `；最新候选：${latest.candidate}`;
      c.fix = '在“环境检测”或“Docker 引擎管理”点“更新 Docker 引擎”即可升级到最新版。';
    } else { c.status = 'ok'; }
  } catch (e) { c.detail = 'WSL 内未找到 docker：' + (e.message || '').slice(0, 160); }
  return c;
}

// 5) WSL 内核/运行时是否为最新
async function checkWslKernel() {
  const c = { key: 'wslkernel', label: 'WSL 内核/运行时为最新', ok: false, status: 'unknown', detail: '', fix: '运行 `wsl --update` 更新 WSL 内核。' };
  try {
    const r = await wslVersionRaw();
    const m = r.match(/[Kk]ernel version:\s*([^\r\n]+)/);
    if (m) c.detail = '内核 ' + m[1].trim();
    const u = await runWslRaw(['--update', '--dry-run'], { timeout: 15000 }).catch(() => null);
    const out = (u && (u.stdout + (u.stderr || ''))) || '';
    if (/no updates are available|已是最新|no update/i.test(out)) { c.ok = true; c.status = 'ok'; c.detail += '（已是最新）'; }
    else if (out.trim()) { c.status = 'outdated'; c.detail += '；有可用更新：' + out.trim().slice(0, 80); }
  } catch (e) { c.detail = '检测失败：' + (e.message || '').slice(0, 120); }
  return c;
}

// 6) .wslconfig 正确配置（内存上限 / systemd / localhost 转发）
async function checkWslConfig() {
  const c = { key: 'wslconfig', label: '.wslconfig 已配置(内存上限 / systemd / localhost转发)', ok: false, status: 'misconfigured', detail: '', fix: '点击右侧“修复 .wslconfig”按钮（自动补写缺失项，保留 networkingMode 等既有配置），或手动编辑 %USERPROFILE%\\.wslconfig。' };
  try {
    const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.wslconfig');
    if (!fs.existsSync(p)) { c.status = 'missing'; c.detail = '未找到 %USERPROFILE%\\.wslconfig'; return c; }
    const txt = fs.readFileSync(p, 'utf8');
    const hasMem = /^\s*memory\s*=/im.test(txt);
    const sysd = /^\s*systemd\s*=\s*true/im.test(txt);
    const fwd = /^\s*localhostforwarding\s*=\s*true/im.test(txt);
    const issues = [];
    if (!hasMem) issues.push('memory 上限');
    if (!sysd) issues.push('systemd=true');
    if (!fwd) issues.push('localhostForwarding=true');
    if (issues.length === 0) { c.ok = true; c.status = 'ok'; c.detail = '已包含 memory / systemd=true / localhostForwarding=true'; }
    else { c.status = 'misconfigured'; c.detail = '缺少：' + issues.join('、'); }
  } catch (e) { c.detail = '检测失败：' + e.message; }
  return c;
}

// 7) Windows 侧 DOCKER_HOST 已设置
async function checkDockerHostEnv() {
  const c = { key: 'dockerhost', label: 'Windows 侧 DOCKER_HOST 已设置(tcp://localhost:2375)', ok: false, status: 'misconfigured', detail: '', fix: '设置用户环境变量 DOCKER_HOST=tcp://localhost:2375。' };
  const v = process.env.DOCKER_HOST || '';
  if (/localhost:2375|127\.0\.0\.1:2375/i.test(v)) { c.ok = true; c.status = 'ok'; c.detail = 'DOCKER_HOST=' + v; }
  else { c.detail = v ? ('DOCKER_HOST=' + v + '（不是 tcp://localhost:2375）') : '未设置 DOCKER_HOST'; }
  return c;
}

// 8) dockerd 已配置监听 2375（systemd 覆盖）
async function checkDockerdOverride() {
  const c = { key: 'dockerdoverride', label: 'dockerd 已配置监听 2375(systemd 覆盖)', ok: false, status: 'unknown', detail: '', fix: '运行完整安装向导以写入 systemd 覆盖。' };
  try {
    const out = await runWsl(['bash', '-c', 'cat /etc/systemd/system/docker.service.d/override.conf 2>/dev/null || echo __NONE__'], { timeout: 20000 });
    if (/127\.0\.0\.1:2375/.test(out)) { c.ok = true; c.status = 'ok'; c.detail = '覆盖文件存在且含 tcp://127.0.0.1:2375'; }
    else if (/__NONE__/.test(out)) { c.detail = '未找到 systemd 覆盖文件'; }
    else { c.detail = '覆盖文件存在但未包含 2375 监听'; }
  } catch (e) { c.detail = '检测失败（Docker 可能未安装）：' + (e.message || '').slice(0, 120); }
  return c;
}

// 9) 保活计划任务已创建
async function checkKeepAliveTask() {
  const c = { key: 'keepalive', label: '保活计划任务 WslDockerKeepAlive 已创建', ok: false, status: 'missing', detail: '', fix: '运行完整安装向导以创建保活任务。' };
  try {
    const r = await ps("if (Get-ScheduledTask -TaskName 'WslDockerKeepAlive' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }");
    if (/yes/i.test(r.stdout)) { c.ok = true; c.status = 'ok'; c.detail = '计划任务存在'; }
    else c.detail = '未找到 WslDockerKeepAlive 计划任务';
  } catch (e) { c.detail = '检测失败：' + e.message; }
  return c;
}

// 10) Windows 侧 docker.exe（可选组件）
async function checkWindowsDockerCli() {
  const c = { key: 'windowsdocker', label: 'Windows 侧 docker.exe 已安装(可选)', ok: false, status: 'unknown', detail: '', fix: '安装脚本会自动下载静态 docker.exe 到项目 bin 目录并加入 PATH。' };
  try {
    const r = await sh('docker.exe', ['--version'], { timeout: 15000 });
    if (r.ok) { c.ok = true; c.status = 'ok'; c.detail = r.stdout; } else c.detail = '未找到 docker.exe';
  } catch (e) { c.detail = '未找到 docker.exe（可选组件）'; }
  return c;
}

// 单独（重新）创建保活计划任务 WslDockerKeepAlive，无需重跑整个安装向导。
// 与 install/setup-prereqs.ps1 第 9 步使用完全相同的任务定义。
// 后端已是管理员时直接创建；否则尝试 UAC 提权（弹窗点“是”）。
// 为避免 %TEMP% 中文路径与嵌套引号导致提权失败，这里把脚本写到项目 install 目录
// （ASCII 路径），并用 #Requires -RunAsAdministrator 兜底。
async function ensureKeepAliveTask() {
  const installDir = path.join(cfg.rootDir, 'install');
  if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });
  const scriptPath = path.join(installDir, 'create-keepalive.ps1');
  const psBody = `#Requires -RunAsAdministrator
$ErrorActionPreference='Stop'
$kaAction = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument '-d ${DISTRO} -u root sleep infinity'
$kaTrigger = New-ScheduledTaskTrigger -AtLogOn
$kaSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'WslDockerKeepAlive' -Action $kaAction -Trigger $kaTrigger -Settings $kaSettings -Force | Out-Null
Start-ScheduledTask -TaskName 'WslDockerKeepAlive' -ErrorAction SilentlyContinue
'KEEPALIVE_OK'
`;
  fs.writeFileSync(scriptPath, '﻿' + psBody, { encoding: 'utf8' });

  // 1) 后端进程已是管理员：直接创建，无需 UAC
  if (isAdmin()) {
    const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { timeout: 60000 });
    if (r.ok && /KEEPALIVE_OK/.test(r.stdout)) return { ok: true, message: '保活任务已创建并启动' };
    return { ok: false, message: '创建失败：' + ((r.stderr || r.stdout || '').slice(0, 200)) };
  }

  // 2) 非管理员：以 UAC 提权运行（弹窗点“是”）。
  //    注意：必须用数组传参（-ArgumentList @(...)）避免引号嵌套破坏命令——
  //    之前把整个命令拼成带嵌套双引号的 -Command 字符串，PowerShell 会提前闭合
  //    外层引号，导致 Start-Process 收不到脚本路径而静默失败。
  const cmd = `$p='${scriptPath}'; Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$p) -Wait`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 120000 }).catch(() => {});
  await sleep(2000);
  const chk = await ps("(Get-ScheduledTask -TaskName 'WslDockerKeepAlive' -ErrorAction SilentlyContinue) ? 'yes' : 'no'");
  if (/yes/i.test(chk.stdout)) return { ok: true, message: '保活任务已创建并启动（已 UAC 提权）' };
  return { ok: false, message: '创建失败：UAC 提权被取消或脚本未能启动。最快解法：右键 D:\\WslDockerManager\\CreateKeepAliveAsAdmin.bat → “以管理员身份运行”（UAC 点“是”）即可直接建任务，无需后端管理员权限。或右键 RunAsAdmin.bat 以管理员重启后端后重试。' };
}

const CHECKS = [
  checkVirtualization, checkWsl, checkDebian, checkDocker, checkWslKernel,
  checkWslConfig, checkDockerHostEnv, checkDockerdOverride, checkKeepAliveTask, checkWindowsDockerCli,
];

// 汇总报告：每项状态 one of ok | missing | outdated | misconfigured | unknown
async function checkPrerequisites() {
  const results = await Promise.allSettled(CHECKS.map((fn) => fn()));
  const components = results.map((r, i) => (r.status === 'fulfilled' ? r.value : { key: 'check' + i, label: '检测失败', ok: false, status: 'unknown', detail: (r.reason && r.reason.message) || '未知错误', fix: '' }));
  const bad = components.filter((c) => ['missing', 'outdated', 'misconfigured'].includes(c.status));
  const report = {
    ok: true,
    allOk: bad.length === 0,
    windowsAdmin: isAdmin(),
    generatedAt: Date.now(),
    components,
    missing: bad.length,
  };
  return report;
}

// ===========================================================================
//  一键安装：提权运行 install/setup-prereqs.ps1，轮询其进度日志
// ===========================================================================
function tailNew(logFile, state) {
  try {
    const sz = fs.statSync(logFile).size;
    if (sz < state.pos) state.pos = 0;
    if (sz === state.pos) return '';
    const fd = fs.openSync(logFile, 'r');
    const buf = Buffer.alloc(sz - state.pos);
    fs.readSync(fd, buf, 0, buf.length, state.pos);
    fs.closeSync(fd);
    state.pos = sz;
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

async function runInstall(onLog, onProgress) {
  const installDir = path.join(cfg.rootDir, 'install');
  if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });
  // 日志写到临时目录（非管理员也可读；提权后的脚本也能写）
  const logFile = path.join(os.tmpdir(), 'wsldocker-prereqs-install.log');
  for (const f of [logFile, logFile + '.done', logFile + '.error']) { try { fs.unlinkSync(f); } catch (_) {} }
  fs.writeFileSync(logFile, '');

  const script = path.join(installDir, 'setup-prereqs.ps1');
  if (!fs.existsSync(script)) { onLog('未找到安装脚本：' + script); return { status: 'error', message: '安装脚本缺失' }; }

  const admin = isAdmin();
  let spawnArgs;
  if (admin) {
    spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProjectDir', cfg.rootDir, '-Distro', DISTRO, '-LogPath', logFile];
  } else {
    // 非管理员：UAC 提权运行安装向导。同样用数组传参避免引号嵌套破坏命令
    // （logFile 含中文用户名路径，作为独立数组元素传递即可，无需额外加引号）。
    const cmd = `$s='${script}'; $pd='${cfg.rootDir}'; $d='${DISTRO}'; $l='${logFile}'; Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$s,'-ProjectDir',$pd,'-Distro',$d,'-LogPath',$l)`;
    spawnArgs = ['-NoProfile', '-Command', cmd];
  }
  onLog('启动安装向导（' + (admin ? '以管理员身份直接运行' : '将弹出 UAC 提权窗口，请点击“是”') + '）…');

  let child;
  try {
    child = spawn('powershell.exe', spawnArgs, { windowsHide: true, stdio: 'ignore' });
  } catch (e) {
    onLog('启动失败：' + e.message);
    return { status: 'error', message: e.message };
  }

  const state = { pos: 0 };
  let lastActivity = Date.now();
  let sawStep = false;
  let result = null;
  const TOTAL = 9;
  const deadline = Date.now() + 45 * 60 * 1000; // 最长 45 分钟
  while (Date.now() < deadline) {
    await sleep(1500);
    const chunk = tailNew(logFile, state);
    if (chunk) {
      lastActivity = Date.now();
      for (const raw of chunk.split('\n')) {
        const t = raw.trim();
        if (!t) continue;
        const m = t.match(/^##STEP\s+(\d+)\/(\d+)\s+(.*)$/);
        if (m) {
          sawStep = true;
          const n = parseInt(m[1], 10);
          const total = parseInt(m[2], 10) || TOTAL;
          onProgress(Math.min(99, Math.round(((n - 1) / total) * 100 + 1)));
          onLog('▶ ' + m[3]);
        } else if (/^##REBOOT/.test(t)) {
          result = 'done_reboot'; break;
        } else if (/^##DONE/.test(t)) {
          result = 'done'; break;
        } else if (/^##ERROR/.test(t)) {
          result = 'error'; onLog(t.replace('##ERROR', '安装错误：')); break;
        } else {
          onLog(t);
        }
      }
    }
    if (result) break;
    if (!sawStep && Date.now() - lastActivity > 75 * 1000) {
      onLog('安装脚本未在预期时间内启动（可能已取消 UAC 提权，或安装脚本路径不可访问）。如需重试，请重新点击“一键安装”。');
      try { child.kill(); } catch (_) {}
      return { status: 'cancelled', message: 'UAC 提权被取消或脚本未启动' };
    }
  }
  try { child.kill(); } catch (_) {}
  if (!result) {
    result = fs.existsSync(logFile + '.done') ? 'done' : 'timeout';
  }
  invalidatePrereqCache();
  if (result === 'done' || result === 'done_reboot') {
    const prereqs = await checkPrerequisites().catch(() => null);
    return {
      status: result,
      prereqs,
      message: result === 'done_reboot'
        ? '安装已完成，但因启用了 Windows 功能，建议重启电脑后再打开本程序以完成最终配置。'
        : '环境安装与配置已全部完成。',
    };
  }
  return { status: result === 'timeout' ? 'error' : result, message: result === 'timeout' ? '安装超时（超过 45 分钟），请检查 install 日志或手动运行 install/setup-prereqs.ps1。' : '安装未完成。' };
}

// ---- 缓存（启动自检 + 周期刷新；安装完成后失效） ----
let cache = { at: 0, data: null };
async function getPrereqs(refresh) {
  const now = Date.now();
  if (!refresh && cache.data && now - cache.at < 120000) return cache.data;
  const data = await checkPrerequisites();
  cache = { at: now, data };
  return data;
}
function invalidatePrereqCache() { cache = { at: 0, data: null }; }

module.exports = { checkPrerequisites, runInstall, getPrereqs, invalidatePrereqCache, isAdmin, ensureKeepAliveTask };
