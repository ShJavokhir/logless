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
WITH_DATA=0; [[ "${1:-}" == "--data" ]] && WITH_DATA=1

echo "==> build web (real API)"
(cd web && VITE_MOCK=0 pnpm -s build)

echo "==> sync code"
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude '.venv' --exclude '__pycache__' --exclude '*.pyc' --exclude '.pytest_cache' \
  backend/ logless-app:/opt/logless/backend/
rsync -az --delete -e "$RSYNC_SSH" web/dist/ logless-app:/opt/logless/web/dist/
rsync -az -e "$RSYNC_SSH" infra/logless-api.service logless-app:/etc/systemd/system/logless-api.service

echo "==> env file"
python3 - <<'EOF' | $SSH 'umask 027; cat > /etc/logless/env.new && chown root:logless /etc/logless/env.new && chmod 0640 /etc/logless/env.new && mv /etc/logless/env.new /etc/logless/env'
env = dict(l.strip().split("=", 1) for l in open(".env") if "=" in l and not l.startswith("#"))
keep = ["VULTR_INFERENCE_API_KEY", "TYPESAFE_API_KEY", "FIREWORKS_API_KEY", "PSEUDONYM_SALT", "RUNNER_TOKEN", "SAMPLE_SIZE", "SAMPLE_SEED"]
for k in keep:
    print(f"{k}={env[k]}")
print("LOGLESS_ENV=production")
print("LOGLESS_DATA_DIR=/var/lib/logless")
print("RUNNER_URL=http://10.20.0.4:8787")
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
  sudo -u logless env UV_CACHE_DIR=/opt/logless/.uv-cache uv pip install -q --python .venv/bin/python -e .;
  systemctl daemon-reload; systemctl enable -q logless-api; systemctl restart logless-api; sleep 2; systemctl is-active logless-api'
echo "==> health"
curl -s https://144-202-110-2.sslip.io/api/health; echo
