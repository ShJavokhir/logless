#!/usr/bin/env bash
# Temporarily lift the sandbox egress lockdown (e.g. for apt upgrades or docker pulls/builds).
# Run as root ON the sandbox VM:
#   ssh -F infra/ssh_config logless-sandbox 'bash -s' < infra/sandbox-unlock.sh
# The unit stays enabled, so a reboot re-locks. Re-lock now with:
#   ssh -F infra/ssh_config logless-sandbox 'systemctl start logless-lockdown.service'
# or re-run sandbox-lockdown.sh.
#
# RELOCK_AFTER=N (optional): automatically re-lock after N seconds.
set -euo pipefail

systemctl stop logless-lockdown.service 2>/dev/null || true
nft delete table inet logless_lockdown 2>/dev/null || true
echo ">> lockdown lifted (outbound open)"

if [[ -n ${RELOCK_AFTER:-} ]]; then
  systemctl stop logless-relock.timer 2>/dev/null || true
  systemd-run --unit logless-relock --on-active="$RELOCK_AFTER" \
    /usr/bin/systemctl start logless-lockdown.service >/dev/null
  echo ">> will re-lock in ${RELOCK_AFTER}s (cancel: systemctl stop logless-relock.timer)"
fi
