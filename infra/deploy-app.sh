#!/usr/bin/env bash
# Deploy the API + web app to the app VM.
#   infra/deploy-app.sh            code + web + env + restart
#   infra/deploy-app.sh --data     also copy var/private.db + var/public.db (consistent sqlite backups)
# Secrets are read from the repo-root .env on the operator machine and written to
# /etc/logless/env (root:logless 0640) on the VM. The Vultr account key is never copied.
set -euo pipefail
cd "$(dirname "$0")/.."
SSH="ssh -F infra/ssh_config logless-app"
RSYNC_SSH="ssh -F infra/ssh_config"
WITH_DATA=0
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--data" ) ]]; then
  echo "Usage: infra/deploy-app.sh [--data]" >&2
  exit 2
fi
[[ "${1:-}" == "--data" ]] && WITH_DATA=1
[[ -s backend/uv.lock ]] || { echo "Missing backend/uv.lock; refusing an unlocked deployment." >&2; exit 1; }

echo "==> build web (real API)"
(cd web && VITE_MOCK=0 pnpm -s build)

echo "==> build video brief bundle (MP4 export; see infra/setup-render.sh)"
(cd web && node video-render/render.mjs --make-bundle ../var/brief-bundle >/dev/null)

echo "==> sync code"
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude '.venv' --exclude '__pycache__' --exclude '*.pyc' --exclude '.pytest_cache' \
  backend/ logless-app:/opt/logless/backend/
rsync -az --delete -e "$RSYNC_SSH" web/dist/ logless-app:/opt/logless/web/dist/
rsync -az -e "$RSYNC_SSH" infra/logless-api.service logless-app:/etc/systemd/system/logless-api.service
# The renderer package and headless Chrome are installed once by infra/setup-render.sh.
if $SSH 'test -x /opt/node/bin/node && test -d /opt/logless/render/node_modules/@remotion/renderer'; then
  rsync -az --delete -e "$RSYNC_SSH" var/brief-bundle/ logless-app:/opt/logless/render/bundle/
  rsync -az -e "$RSYNC_SSH" web/video-render/render.mjs web/video-render/package.json logless-app:/opt/logless/render/
  RENDER=1
else
  echo "    (no renderer on the VM: briefs stay player-only; run infra/setup-render.sh to enable MP4 export)"
  RENDER=0
fi

echo "==> env file"
RENDER=$RENDER python3 - <<'EOF' | $SSH 'umask 027; cat > /etc/logless/env.new && chown root:logless /etc/logless/env.new && chmod 0640 /etc/logless/env.new && mv /etc/logless/env.new /etc/logless/env'
import os
env = dict(l.strip().split("=", 1) for l in open(".env") if "=" in l and not l.startswith("#"))
keep = ["VULTR_INFERENCE_API_KEY", "TYPESAFE_API_KEY", "FIREWORKS_API_KEY", "PSEUDONYM_SALT", "RUNNER_TOKEN", "SAMPLE_SIZE", "SAMPLE_SEED",
        "PRESENTER_KEY"]
for k in keep:
    print(f"{k}={env[k]}")
for k in ("NETBIRD_API_URL", "NETBIRD_API_TOKEN", "NETBIRD_PEER_ID", "NETBIRD_TARGET_PORT",
          "NETBIRD_PROXY_DOMAIN", "REMOTE_TTL_MIN", "REMOTE_DESKTOP_IDLE_S"):
    if env.get(k):
        print(f"{k}={env[k]}")
print("LOGLESS_ENV=production")
print("LOGLESS_DATA_DIR=/var/lib/logless")
print("RUNNER_URL=http://10.20.0.4:8787")
# Receipts show the sandbox image digest only if the runner reports exactly this id (the runner
# itself refuses to run any other image; see /etc/logless-runner/env RUNNER_IMAGE_DIGEST).
if os.environ.get("RENDER") == "1":
    print("BRIEF_RENDER_NODE=/opt/node/bin/node")
    print("BRIEF_RENDER_SCRIPT=/opt/logless/render/render.mjs")
    print("BRIEF_RENDER_BUNDLE=/opt/logless/render/bundle")
    print("BRIEF_RENDER_HOME=/tmp")
print("SANDBOX_IMAGE_DIGEST=" + env.get("SANDBOX_IMAGE_DIGEST", "sha256:91c87e91583edb8cbe9f63de89294f8f269e123d767078ac35f7023df7aefce9"))
EOF

if [[ $WITH_DATA == 1 ]]; then
  echo "==> data (sqlite online backups)"
  mkdir -p var/deploy
  sqlite3 var/private.db ".backup var/deploy/private.db"
  sqlite3 var/public.db ".backup var/deploy/public.db"
  $SSH 'systemctl stop logless-api 2>/dev/null || true'
  rsync -az -e "$RSYNC_SSH" var/deploy/private.db var/deploy/public.db logless-app:/var/lib/logless/
  [[ -d var/embeddings ]] && rsync -az -e "$RSYNC_SSH" var/embeddings/ logless-app:/var/lib/logless/embeddings/
  [[ -d var/artifacts ]] && rsync -az -e "$RSYNC_SSH" var/artifacts/ logless-app:/var/lib/logless/artifacts/
  $SSH 'chown -R logless:logless /var/lib/logless && chmod 750 /var/lib/logless && rm -f /var/lib/logless/*.db-wal /var/lib/logless/*.db-shm'
  rm -rf var/deploy
fi

echo "==> python env + restart"
$SSH 'set -e; chown -R logless:logless /opt/logless; cd /opt/logless/backend;
  [ -x .venv/bin/python ] || sudo -u logless uv venv -q -p 3.12 .venv;
  sudo -u logless env UV_CACHE_DIR=/opt/logless/.uv-cache uv sync -q --locked --no-dev;
  systemctl daemon-reload; systemctl enable -q logless-api; systemctl restart logless-api; sleep 2; systemctl is-active logless-api'
if [[ $WITH_DATA == 1 ]]; then
  # Published map numbers are computed by the pipeline on the app VM; nothing is re-run here.
  # Refresh the evaluation report for whatever snapshot is current after the copy.
  echo "==> eval"
  $SSH 'cd /opt/logless/backend && sudo -u logless bash -c "set -a; . /etc/logless/env; set +a; .venv/bin/logless eval >/dev/null"'
fi

echo "==> health"
python3 scripts/smoke_live.py --skip-paid --base-url "${LOGLESS_DEMO_URL:-https://144-202-110-2.sslip.io}"
