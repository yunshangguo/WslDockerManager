#!/usr/bin/env bash
# WslDockerManager - Phase 0 (part A): install Docker Engine inside WSL2 Debian (no Docker Desktop)
# Usage (either):
#   1) Inside WSL2:  wsl -d Debian  ->  sudo bash /mnt/c/.../setup-wsl-docker.sh
#   2) Or let Windows-side setup-wsl-docker.ps1 call this script automatically
set -euo pipefail

# Support running as root (from PS script) and as a normal user (manual)
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
REAL_USER="${SUDO_USER:-$(whoami)}"

echo "==> [1/5] Update apt and install dependencies"
$SUDO apt-get update
$SUDO apt-get install -y ca-certificates curl gnupg lsb-release

echo "==> [2/5] Add Docker official GPG key and apt repo"
$SUDO install -m 0755 -d /etc/apt/keyrings
$SUDO curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
$SUDO chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null

echo "==> [3/5] Install Docker Engine + compose plugin"
$SUDO apt-get update
$SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> [4/5] Configure dockerd to listen on tcp://127.0.0.1:2375 (systemd override, leave daemon.json alone)"
$SUDO mkdir -p /etc/systemd/system/docker.service.d
$SUDO tee /etc/systemd/system/docker.service.d/override.conf > /dev/null <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock
EOF

# Allow current user passwordless docker inside WSL (unix socket only; Windows side uses TCP)
$SUDO usermod -aG docker "$REAL_USER" || true

echo "==> [5/5] Reload and start docker"
# We KNOW systemd is our init (step 3 enabled it), so prefer systemctl.
# Use fd:// so the override cooperates with docker.socket (no double-bind on the unix socket).
$SUDO systemctl daemon-reload 2>/dev/null || true
$SUDO systemctl enable docker 2>/dev/null || true
if ! $SUDO systemctl restart docker 2>/dev/null; then
  $SUDO service docker restart
fi

echo "==> Verify dockerd tcp listener on 127.0.0.1:2375"
if $SUDO docker -H tcp://127.0.0.1:2375 version >/dev/null 2>&1; then
  echo "OK: dockerd listening on tcp://127.0.0.1:2375"
else
  echo "WARN: tcp 2375 not responding inside WSL; check /etc/systemd/system/docker.service.d/override.conf"
fi

echo "==> Verify: run hello-world (non-fatal; network may block the pull)"
$SUDO docker run --rm hello-world || echo "hello-world pull failed (network/proxy?), but Docker Engine should be listening on tcp://127.0.0.1:2375 if the steps above succeeded."
echo "Docker Engine ready: unix socket + tcp://127.0.0.1:2375"
