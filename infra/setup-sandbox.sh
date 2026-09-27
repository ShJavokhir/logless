#!/usr/bin/env bash
# Sandbox VM bootstrap (Ubuntu 24.04). Credential-free machine: never copy API keys here.
# Run as root on logless-sandbox (outbound must be open, i.e. before lockdown or after unlock):
#   scp -F infra/ssh_config -r infra/setup-sandbox.sh infra/sandbox-image logless-sandbox:/root/
#   ssh -F infra/ssh_config logless-sandbox 'bash /root/setup-sandbox.sh'
# Idempotent: safe to re-run. Set BUILD_IMAGE=0 to skip the image build.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT="apt-get -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=logless-analysis:1

echo ">> apt update/upgrade"
$APT update
$APT upgrade
$APT install ca-certificates curl gnupg python3.12 python3.12-venv nftables unattended-upgrades

cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo ">> host firewall: disable Vultr-image ufw; sandbox-lockdown.sh (nftables) is the single host ruleset"
if command -v ufw >/dev/null; then ufw --force disable >/dev/null || true; fi

echo ">> Docker Engine (official apt repo)"
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
    >/etc/apt/sources.list.d/docker.list
  $APT update
fi
$APT install docker-ce docker-ce-cli containerd.io docker-buildx-plugin

echo ">> gVisor runsc (official apt repo)"
if [[ ! -f /usr/share/keyrings/gvisor-archive-keyring.gpg ]]; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    >/etc/apt/sources.list.d/gvisor.list
  $APT update
fi
$APT install runsc
# Register runsc with Docker. systrap is gVisor's default platform; we pin it explicitly so it
# is visible in /etc/docker/daemon.json (no nested virt on Vultr vc2, so the KVM platform is out).
runsc install -- --platform=systrap
systemctl restart docker

echo ">> uv"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi

echo ">> runner user"
id runner >/dev/null 2>&1 || useradd --system --home-dir /opt/logless-runner --no-create-home \
  --shell /usr/sbin/nologin --user-group runner
usermod -aG docker runner
install -d -o runner -g runner -m 750 /opt/logless-runner

if [[ ${BUILD_IMAGE:-1} == 1 && -f $HERE/sandbox-image/Dockerfile ]]; then
  echo ">> build $IMAGE"
  docker build --pull -t "$IMAGE" "$HERE/sandbox-image"
fi

echo ">> versions"
docker version --format 'docker {{.Server.Version}}'
runsc --version | head -n1
python3.12 --version; uv --version
docker info --format 'runtimes: {{range $k, $v := .Runtimes}}{{$k}} {{end}}'
[[ -f /var/run/reboot-required ]] && echo "!! reboot required" || true
echo ">> setup-sandbox done"
