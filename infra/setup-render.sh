#!/usr/bin/env bash
# One-time: prepare the app VM to export video briefs as MP4 (docs/VIDEO_BRIEF.md).
# Installs a pinned Node tarball under /opt/node, Chrome's shared libraries, and
# /opt/logless/render (renderer package + headless Chrome). infra/deploy-app.sh then
# ships render.mjs and the pre-built composition bundle and sets BRIEF_RENDER_* in the env.
# The renderer executes only our own composition; briefs are gated data.
set -euo pipefail
cd "$(dirname "$0")/.."
SSH="ssh -F infra/ssh_config logless-app"
NODE_VERSION=v22.20.0

$SSH "NODE_VERSION=$NODE_VERSION bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends xz-utils ca-certificates \
  libnss3 libdbus-1-3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 libasound2t64 fonts-liberation >/dev/null
if [ ! -x /opt/node/bin/node ] || [ "$(/opt/node/bin/node -v)" != "$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " node-$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sed "s#node-$NODE_VERSION-linux-x64.tar.xz#node.tar.xz#" | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1
  rm -rf "$tmp"
fi
/opt/node/bin/node -v
mkdir -p /opt/logless/render
REMOTE

rsync -az -e "ssh -F infra/ssh_config" web/video-render/package.json logless-app:/opt/logless/render/package.json
$SSH 'set -e; cd /opt/logless/render && PATH=/opt/node/bin:$PATH npm install --no-audit --no-fund --omit=dev -q &&
  PATH=/opt/node/bin:$PATH node -e "import(\"@remotion/renderer\").then(r => r.ensureBrowser()).then(() => console.log(\"chrome ok\"))" &&
  chown -R logless:logless /opt/logless/render'
