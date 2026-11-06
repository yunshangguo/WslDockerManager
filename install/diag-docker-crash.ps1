# diag-docker-crash.ps1
# Collect evidence about why dockerd crashes ~15-20s after starting inside WSL/Debian.
# MUST be run as Administrator on the HOST (it needs wsl.exe, which is blocked inside the AI sandbox).
# Output is printed to the console; copy/paste it back so the root cause can be fixed.
$ErrorActionPreference = 'Continue'
$distro = 'Debian'

function Run([string]$cmd) {
  try { wsl -d $distro -u root bash -c $cmd 2>&1 } catch { "<<wsl error: $_>>" }
}

Write-Host "===== dockerd crash diagnostic (WSL distro: $distro) =====" -ForegroundColor Cyan

Write-Host "`n[1] systemd as PID1 + docker unit Restart policy" -ForegroundColor Yellow
Run "echo 'systemd:'; [ -d /run/systemd/system ] && echo yes || echo no; echo '--- Restart/StartLimit ---'; systemctl cat docker 2>/dev/null | grep -iE 'Restart|StartLimit'; echo '--- override.conf ---'; cat /etc/systemd/system/docker.service.d/override.conf 2>/dev/null"

Write-Host "`n[2] dockerd journal (journalctl -u docker)" -ForegroundColor Yellow
Run "journalctl -u docker --no-pager -n 80"

Write-Host "`n[3] /var/log/docker.log + /var/log/dockerd-tcp.log" -ForegroundColor Yellow
Run "echo '--- docker.log ---'; tail -n 60 /var/log/docker.log 2>/dev/null; echo '--- dockerd-tcp.log ---'; tail -n 60 /var/log/dockerd-tcp.log 2>/dev/null"

Write-Host "`n[4] containerd state + socket" -ForegroundColor Yellow
Run "systemctl status containerd --no-pager 2>/dev/null | head -n 12; echo '---'; ls -l /run/containerd/containerd.sock 2>/dev/null || echo 'no containerd socket'"

Write-Host "`n[5] memory / OOM hints" -ForegroundColor Yellow
Run "free -m 2>/dev/null | head -n 2; echo '--- dmesg OOM ---'; dmesg 2>/dev/null | grep -i 'killed process' | tail -n 10"

Write-Host "`n[6] /etc/docker/daemon.json" -ForegroundColor Yellow
Run "cat /etc/docker/daemon.json 2>/dev/null || echo 'no daemon.json'"

Write-Host "`n===== common-cause quick reference =====" -ForegroundColor Cyan
Write-Host " - Restart != always and dockerd crashes -> systemd will NOT restart it: 'systemctl edit docker' add [Service] Restart=always, then 'systemctl daemon-reload; systemctl restart docker'"
Write-Host " - containerd lost -> 'systemctl restart containerd' then 'systemctl restart docker'"
Write-Host " - storage-driver error -> set daemon.json { \"storage-driver\": \"overlay2\" }"
Write-Host " - OOM -> add to /etc/wsl.conf: [wsl2] memory=4GB  then 'wsl --shutdown'"
Write-Host " - iptables/nftables errors -> add --iptables=false (this project's startDockerdDirect already does)"
Write-Host "`nPaste the [1]-[6] output back to the assistant to fix the root cause." -ForegroundColor Green
