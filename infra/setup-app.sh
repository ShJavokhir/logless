#!/usr/bin/env bash
# App VM bootstrap (Ubuntu 24.04). Run as root on logless-app:
#   scp -F infra/ssh_config infra/setup-app.sh infra/Caddyfile logless-app:/root/
#   ssh -F infra/ssh_config logless-app 'LOGLESS_HOST=144-202-110-2.sslip.io bash /root/setup-app.sh'
# Idempotent: safe to re-run.
set -euo pipefail

: "${LOGLESS_HOST:?set LOGLESS_HOST, e.g. 144-202-110-2.sslip.io}"
CADDYFILE_SRC=${CADDYFILE_SRC:-$(cd "$(dirname "$0")" && pwd)/Caddyfile}
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT="apt-get -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"

echo ">> apt update/upgrade"
$APT update
$APT upgrade
$APT install ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https \
  python3.12 python3.12-venv sqlite3 git rsync unattended-upgrades

echo ">> unattended-upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo ">> Caddy (official cloudsmith apt repo)"
if [[ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  $APT update
fi
$APT install caddy

echo ">> host firewall (ufw ships enabled on Vultr's Ubuntu image with only 22/tcp open)"
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow in on wt0 to any port 8080 proto tcp >/dev/null
fi

echo ">> uv"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi

echo ">> user + directories"
id logless >/dev/null 2>&1 || useradd --system --home-dir /var/lib/logless --no-create-home \
  --shell /usr/sbin/nologin --user-group logless
install -d -o logless -g logless -m 755 /opt/logless /opt/logless/web /opt/logless/web/dist
install -d -o logless -g logless -m 750 /var/lib/logless
install -d -o root -g logless -m 750 /etc/logless
if [[ ! -f /opt/logless/web/dist/index.html ]]; then
  cat >/opt/logless/web/dist/index.html <<'EOF'
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>logless</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<p>logless — deploying</p></body></html>
EOF
  chown logless:logless /opt/logless/web/dist/index.html
  chmod 644 /opt/logless/web/dist/index.html
fi

echo ">> Caddyfile for $LOGLESS_HOST"
sed "s/__LOGLESS_HOST__/$LOGLESS_HOST/g" "$CADDYFILE_SRC" >/etc/caddy/Caddyfile.new
caddy fmt --overwrite /etc/caddy/Caddyfile.new >/dev/null 2>&1 || true
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null
systemctl reload-or-restart caddy

echo ">> versions"
caddy version; python3.12 --version; uv --version; sqlite3 --version | cut -d' ' -f1; git --version
[[ -f /var/run/reboot-required ]] && echo "!! reboot required" || true
echo ">> setup-app done"
