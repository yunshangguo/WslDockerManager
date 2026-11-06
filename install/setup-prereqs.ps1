#Requires -RunAsAdministrator
# WslDockerManager - 完整环境安装向导（项目“环境检测”页一键安装所调用的脚本）
# 在已提权（RunAs）的 PowerShell 中运行。依次完成：
#   1) 检测虚拟化并启用 WSL 所需 Windows 功能
#   2) 安装/更新 WSL 运行时
#   3) 安装 Debian 发行版（必要时迁移到 D:）
#   4) 写入 .wslconfig（内存上限 / systemd / localhost 转发）
#   5) 启用 systemd
#   6) 在 WSL 内安装 Docker 引擎（调用 setup-wsl-docker.sh）
#   7) 安装 Windows 侧 docker.exe 并设置 DOCKER_HOST
#   8) 创建自启 + 保活计划任务
#   9) 验证并收尾
# 进度以 `##STEP n/9 名称` 写入日志，供后端轮询；完成写 `##DONE`，需重启写 `##REBOOT`。
[CmdletBinding()]
param(
  [string]$ProjectDir = 'D:\WslDockerManager',
  [string]$Distro = 'Debian',
  [string]$DistroLocation = 'D:\WSL\Debian',
  [string]$DockerVer = '27.5.1',
  [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $LogPath) { $LogPath = Join-Path $PSScriptRoot 'prereqs-install.log' }

$TOTAL = 9
$stepNo = 0
$rebootNeeded = $false

function Write-Log($msg) {
  try { Add-Content -Path $LogPath -Value $msg -Encoding UTF8 } catch { }
}
function Step($name) {
  $script:stepNo++
  $p = "##STEP $($script:stepNo)/$TOTAL $name"
  Write-Log $p
  Write-Host "`n==> [$stepNo/$TOTAL] $name"
}
function WinToWsl($winPath) {
  $p = $winPath -replace '\\', '/'
  if ($p -match '^([A-Za-z]):') { $p = '/mnt/' + $Matches[1].ToLower() + $p.Substring(2) }
  return $p
}

try {
  Step '检测虚拟化并启用 WSL 功能'
  $hv = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
  if (-not $hv) {
    Write-Log '##ERROR 未检测到 CPU 虚拟化(HypervisorPresent=False)。请先在 BIOS/UEFI 中开启 VT-x/AMD-V，再运行本向导。'
    exit 1
  }
  Write-Log '虚拟化已开启(HypervisorPresent=True)'
  foreach ($f in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')) {
    $st = (Get-WindowsOptionalFeature -Online -FeatureName $f).State
    if ($st -ne 'Enabled') {
      Write-Log "启用 Windows 功能: $f ..."
      $r = Enable-WindowsOptionalFeature -Online -FeatureName $f -NoRestart
      if ($r.RestartNeeded) { $rebootNeeded = $true }
    } else { Write-Log "$f 已启用" }
  }

  Step '安装/更新 WSL 运行时'
  $wslVer = & wsl --version 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Log 'wsl 命令不可用，执行 wsl --install ...'
    & wsl --install --no-launch 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Log '##ERROR 自动安装 WSL 失败，请手动以管理员运行 `wsl --install` 后重启电脑再试。'
      exit 1
    }
    $rebootNeeded = $true
  } else {
    & wsl --update 2>&1 | Out-Host
    & wsl --set-default-version 2 2>&1 | Out-Null
    Write-Log 'WSL 运行时已更新'
  }

  Step "安装 $Distro 发行版"
  $list = (wsl -l -v 2>&1) -join "`n"
  if ($list -notmatch [regex]::Escape($Distro)) {
    Write-Log "$Distro 未安装，开始安装..."
    & winget install --id TheDebianProject.Debian -e --accept-package-agreements --accept-source-agreements 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Log 'winget 安装失败，改用 wsl --install -d ...'
      & wsl --install -d $Distro --no-launch 2>&1 | Out-Host
    }
    & wsl --shutdown 2>&1 | Out-Null
    $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    $key = Get-ChildItem $lxss -ErrorAction SilentlyContinue | Where-Object { $_.GetValue('DistributionName') -eq $Distro } | Select-Object -First 1
    if ($key -and ($key.GetValue('BasePath') -like 'C:*')) {
      Write-Log "迁移 $Distro 到 $DistroLocation (避免占用 C:)"
      New-Item -ItemType Directory -Force -Path $DistroLocation | Out-Null
      & wsl --manage $Distro --move $DistroLocation 2>&1 | Out-Host
    }
  } else { Write-Log "$Distro 已安装" }

  Step '写入 .wslconfig'
  $wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
  $desired = @'
[wsl2]
# 关键：限制 WSL2 内存，避免 vmmem 吃光主机内存（即使不装 Docker Desktop 也需要）
# 调成主机内存的 1/4~1/2。主机 64GB -> 16GB 较舒适；容器多则调大。
memory=16GB
swap=4GB
localhostForwarding=true
processors=6
# 在 .wslconfig 中显式声明 systemd=true（环境检测项之一；真正的 systemd 启用
# 同时由下方“启用 systemd”步骤写入 WSL 内的 /etc/wsl.conf）。
systemd=true
'@
  if (Test-Path $wslConfig) { Copy-Item $wslConfig "$wslConfig.bak" -Force; Write-Log '已备份旧 .wslconfig' }
  Set-Content -Path $wslConfig -Value $desired -Encoding UTF8
  Write-Log "写入 $wslConfig"

  Step '启用 systemd'
  wsl -d $Distro -u root bash -c "if ! grep -q 'systemd=true' /etc/wsl.conf 2>/dev/null; then printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf; fi"
  wsl --shutdown 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  Write-Log 'systemd 已写入 /etc/wsl.conf'

  Step '在 WSL 内安装 Docker 引擎'
  $shPath = Join-Path $PSScriptRoot 'setup-wsl-docker.sh'
  if (-not (Test-Path $shPath)) { Write-Log "##ERROR 找不到 $shPath"; exit 1 }
  $shWsl = WinToWsl $shPath
  wsl -d $Distro -u root bash "$shWsl" 2>&1 | Out-Host
  Write-Log 'Docker 引擎安装完成'

  Step '安装 Windows 侧 docker.exe 并设置 DOCKER_HOST'
  $binDir = Join-Path $ProjectDir 'bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $url = "https://download.docker.com/win/static/stable/x86_64/docker-$DockerVer.zip"
  $zip = Join-Path $env:TEMP "docker-$DockerVer.zip"
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -ErrorAction Stop
    Expand-Archive -Path $zip -DestinationPath "$env:TEMP\docker-ext-$DockerVer" -Force
    Copy-Item "$env:TEMP\docker-ext-$DockerVer\docker\*.exe" -Destination $binDir -Force
    $cur = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($cur -notlike "*$binDir*") { [Environment]::SetEnvironmentVariable('Path', "$cur;$binDir", 'User') }
    Write-Log "docker.exe 已安装到 $binDir 并加入 PATH"
  } catch { Write-Log "WARN: docker.exe 下载失败（版本 $DockerVer 可能已过时），可手动下载放入 $binDir" }

  Step '创建自启与保活计划任务'
  [Environment]::SetEnvironmentVariable('DOCKER_HOST', 'tcp://localhost:2375', 'User')
  $startAction = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -u root service docker start"
  Register-ScheduledTask -TaskName 'WslDockerStart' -Action $startAction -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force | Out-Null
  $kaAction = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -u root sleep infinity"
  $kaTrigger = New-ScheduledTaskTrigger -At (Get-Date) -Once -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)
  $kaSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'WslDockerKeepAlive' -Action $kaAction -Trigger $kaTrigger -Settings $kaSettings -Force | Out-Null
  Start-ScheduledTask -TaskName 'WslDockerKeepAlive' -ErrorAction SilentlyContinue
  Write-Log '计划任务 WslDockerStart / WslDockerKeepAlive 已创建'

  Step '验证并收尾'
  wsl -d $Distro -u root service docker start 2>&1 | Out-Null
  Start-Sleep -Seconds 5
  $dockerExe = Join-Path $binDir 'docker.exe'
  if (Test-Path $dockerExe) { & $dockerExe -H tcp://localhost:2375 ps 2>&1 | Out-Host }
  Write-Log '验证完成'

  if ($rebootNeeded) { Write-Log '##REBOOT 安装过程中启用了 Windows 功能，建议重启电脑后再次打开本程序以完成最终配置。' }
  Write-Log '##DONE 环境安装与配置已全部完成。'
} catch {
  Write-Log "##ERROR $($_.Exception.Message)"
  exit 1
}
