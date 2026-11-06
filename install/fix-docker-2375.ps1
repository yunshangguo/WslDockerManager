# fix-docker-2375.ps1
# ---------------------------------------------------------------------------
# 一键诊断 + 修复 WslDockerManager 连不上 WSL2 dockerd (127.0.0.1:2375) 的问题。
#
# 现象：后端日志每 30 秒报 "connect ECONNREFUSED 127.0.0.1:2375"，
#       交互式终端 / 所有 Docker 操作都失败。
#
# 根因（最常见）：Debian 发行版被关掉或 docker.service 没起来，
#       而自启任务 WslDockerStart 只在“登录时”触发，睡眠/关机后不会重跑。
#
# 用法（管理员 PowerShell）：
#   cd D:\WslDockerManager\install
#   powershell -ExecutionPolicy Bypass -File .\fix-docker-2375.ps1
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'

$ScriptRoot  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptRoot

# 从项目 config.json 读发行版名（默认 Debian）
$Distro = 'Debian'
$cfgPath = Join-Path $ProjectRoot 'config.json'
if (Test-Path $cfgPath) {
    try { $c = Get-Content $cfgPath -Raw | ConvertFrom-Json; if ($c.distro) { $Distro = $c.distro } } catch {}
}

function Log($m) { Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $m) }
function Ok($m)  { Write-Host ("[{0:HH:mm:ss}] [OK] {1}" -f (Get-Date), $m) -ForegroundColor Green }
function Warn($m){ Write-Host ("[{0:HH:mm:ss}] [!!] {1}" -f (Get-Date), $m) -ForegroundColor Yellow }

Log "项目根: $ProjectRoot | WSL 发行版: $Distro"

# ---------------------------------------------------------------------------
# 1/6 检查 Debian 是否在运行
# ---------------------------------------------------------------------------
Log "== 1/6 检查 WSL 发行版状态 =="
$wslList = (wsl -l -v 2>&1) -join "`n"
$wslList -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host "  $_" } }
$debianRunning = ($wslList -split "`n" | Where-Object { $_ -match 'Debian' -and $_ -match 'Running' }) -ne $null

if (-not $debianRunning) {
    Warn "Debian 未在运行，尝试启动发行版..."
    wsl -d $Distro -u root echo "__wsl_up__" 2>&1 | Out-Null
    Start-Sleep -Seconds 4
    $wslList2 = (wsl -l -v 2>&1) -join "`n"
    $debianRunning = ($wslList2 -split "`n" | Where-Object { $_ -match 'Debian' -and $_ -match 'Running' }) -ne $null
    if ($debianRunning) { Ok "Debian 已启动" } else { Warn "Debian 仍显示未运行（可能正在冷启动，继续尝试起 docker）" }
}

# ---------------------------------------------------------------------------
# 2/6 确保 docker.service 在 WSL 内运行
# ---------------------------------------------------------------------------
Log "== 2/6 确保 docker 服务在 WSL 内运行 =="
$out = wsl -d $Distro -u root bash -c @'
set -e
if command -v systemctl >/dev/null 2>&1 && systemctl --no-pager >/dev/null 2>&1; then
  systemctl is-active --quiet docker 2>/dev/null || systemctl start docker 2>/dev/null
  sleep 2
  systemctl is-active --quiet docker 2>/dev/null && echo "SYSCTL_ACTIVE" || echo "SYSCTL_INACTIVE"
else
  service docker status >/dev/null 2>&1 || service docker start 2>/dev/null
  sleep 2
  service docker status >/dev/null 2>&1 && echo "SERVICE_ACTIVE" || echo "SERVICE_INACTIVE"
fi
'@
$out -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host "  $_" } }
$active = ($out -match 'ACTIVE') -ne $null
if (-not $active) { Warn "docker 服务未能进入 active 状态，下一步将尝试重装 systemd override" }

# ---------------------------------------------------------------------------
# 3/6 确认 dockerd 监听 2375；若未监听则重铺 override.conf 并重启
# ---------------------------------------------------------------------------
Log "== 3/6 确认 dockerd 监听 2375（WSL 内）=="
$listening = wsl -d $Distro -u root bash -c "ss -lntp 2>/dev/null | grep ':2375' || netstat -lntp 2>/dev/null | grep ':2375' || true"
if ($listening) { Ok "dockerd 已在 2375 监听:`n  $listening" }
else {
    Warn "dockerd 未在 2375 监听，重铺 systemd override.conf 并重启 docker..."
    wsl -d $Distro -u root bash -c @'
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock
EOF
systemctl daemon-reload 2>/dev/null || true
systemctl enable docker 2>/dev/null || true
if ! systemctl restart docker 2>/dev/null; then service docker restart 2>/dev/null; fi
sleep 4
'@
    $listening2 = wsl -d $Distro -u root bash -c "ss -lntp 2>/dev/null | grep ':2375' || netstat -lntp 2>/dev/null | grep ':2375' || true"
    if ($listening2) { Ok "修复后已监听:`n  $listening2" } else { Warn "仍未能在 2375 监听，请手动进 WSL 排查: wsl -d $Distro -u root; systemctl status docker" }
}

# ---------------------------------------------------------------------------
# 4/6 从 Windows 侧测试 2375 连通性
# ---------------------------------------------------------------------------
Log "== 4/6 从 Windows 侧测试 127.0.0.1:2375 =="
$reach = Test-NetConnection -ComputerName 127.0.0.1 -Port 2375 -WarningAction SilentlyContinue
if ($reach.TcpTestSucceeded) { Ok "Windows -> 127.0.0.1:2375 已连通" }
else {
    Warn "Windows 侧仍连不上 2375。检查 .wslconfig 的 localhostForwarding 与防火墙。"
    $wf = Join-Path $env:USERPROFILE '.wslconfig'
    if (Test-Path $wf) {
        Write-Host "  .wslconfig 内容:"; Get-Content $wf | ForEach-Object { Write-Host ("    "+$_) }
        if ((Get-Content $wf -Raw) -notmatch 'localhostForwarding\s*=\s*true') {
            Warn "  .wslconfig 缺少 localhostForwarding=true，请加上后运行: wsl --shutdown 再重开。"
        }
    } else { Warn "  未找到 .wslconfig" }
    Write-Host "  防火墙提示: 确认未拦截 wslhost.exe / vmmem 的 2375 入站。"
}

# ---------------------------------------------------------------------------
# 5/6 用 docker.exe 验证 Windows -> WSL 通路
# ---------------------------------------------------------------------------
Log "== 5/6 用 docker.exe 验证 Windows -> WSL2 dockerd 通路 =="
$exe = Get-ChildItem -Path (Join-Path $ProjectRoot 'bin\docker.exe') -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) {
    & $exe.FullName -H tcp://localhost:2375 ps 2>&1 | ForEach-Object { Write-Host ("  "+$_) }
} else {
    Write-Host "  未找到 $ProjectRoot\bin\docker.exe，改用 WSL 内验证: wsl -d $Distro docker ps"
    wsl -d $Distro docker ps 2>&1 | ForEach-Object { Write-Host ("  "+$_) }
}

# ---------------------------------------------------------------------------
# 6/6 重启 WslDockerManager 后端（让新连接生效；supervisor 会自动拉起）
# ---------------------------------------------------------------------------
Log "== 6/6 重启 WslDockerManager 后端 =="
$bat = Join-Path $ProjectRoot 'restart-backend.bat'
if (Test-Path $bat) {
    try {
        & cmd /c "`"$bat`"" 2>&1 | ForEach-Object { Write-Host ("  "+$_) }
        Ok "已触发后端重启（supervisor 将用新代码/新连接拉起 server）"
    } catch {
        Warn "重启脚本执行异常: $_ ；请手动以管理员运行: $bat"
    }
} else {
    # 兜底：直接找到并重启 5050 监听进程
    $listener = Get-NetTCPConnection -LocalPort 5050 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        Stop-Process -Id $listener.OwningProcess -Force
        Ok ("已停止 5050 监听进程 PID={0}，supervisor 将自动重启" -f $listener.OwningProcess)
    } else { Warn "未发现 5050 监听进程（后端可能未运行），可手动启动 start.bat" }
}

Log "完成。请在浏览器 Ctrl+F5 硬刷新，然后重试终端连接。"
