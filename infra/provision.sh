#!/usr/bin/env bash
# Provision logless infrastructure on Vultr (API v2). Idempotent-ish: every
# resource is looked up by name/description first and only created if missing.
#
# Usage (from repo root):
#   set -a; source .env.ops; set +a      # provides VULTR_API_KEY (never commit it)
#   ./infra/provision.sh
#
# Optional overrides via environment:
#   OPERATOR_IP   public IPv4 allowed to SSH (default: curl api.ipify.org)
#   SSH_PUBKEY    path to public key (default: ~/.ssh/logless_vultr.pub)
#
# Writes resource IDs and IPs (no secrets) to infra/resources.env.
set -euo pipefail

: "${VULTR_API_KEY:?VULTR_API_KEY must be set in the environment (source .env.ops)}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

API=https://api.vultr.com/v2
REGION=sjc
PLAN=vc2-4c-8gb
OS_NAME="Ubuntu 24.04 LTS x64"
VPC_DESC=logless-vpc
VPC_SUBNET=10.20.0.0
VPC_MASK=24
SSH_KEY_NAME=logless
SSH_PUBKEY=${SSH_PUBKEY:-$HOME/.ssh/logless_vultr.pub}
SSH_PRIV=${SSH_PUBKEY%.pub}
APP_FW=logless-app-fw
SANDBOX_FW=logless-sandbox-fw
OPERATOR_IP=${OPERATOR_IP:-$(curl -fsS https://api.ipify.org)}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/resources.env"

api() { # api METHOD PATH [JSON]
  local m=$1 p=$2
  if [[ $# -ge 3 ]]; then
    curl -sS --fail-with-body -X "$m" -H "Authorization: Bearer $VULTR_API_KEY" \
      -H 'Content-Type: application/json' --data "$3" "$API$p"
  else
    curl -sS --fail-with-body -X "$m" -H "Authorization: Bearer $VULTR_API_KEY" "$API$p"
  fi
}
log() { printf '>> %s\n' "$*" >&2; }

# ---------------------------------------------------------------- OS id
OS_ID=$(api GET "/os?per_page=500" | jq -r --arg n "$OS_NAME" '.os[] | select(.name==$n) | .id')
[[ -n $OS_ID ]] || { echo "OS '$OS_NAME' not found" >&2; exit 1; }
log "os_id=$OS_ID ($OS_NAME)"

# ---------------------------------------------------------------- SSH key
SSHKEY_ID=$(api GET "/ssh-keys?per_page=500" | jq -r --arg n "$SSH_KEY_NAME" '.ssh_keys[] | select(.name==$n) | .id' | head -n1)
if [[ -z $SSHKEY_ID ]]; then
  SSHKEY_ID=$(api POST /ssh-keys "$(jq -n --arg n "$SSH_KEY_NAME" --arg k "$(cat "$SSH_PUBKEY")" '{name:$n, ssh_key:$k}')" | jq -r '.ssh_key.id')
  log "created ssh key $SSHKEY_ID"
else
  log "ssh key exists $SSHKEY_ID"
fi

# ---------------------------------------------------------------- VPC
VPC_ID=$(api GET "/vpcs?per_page=500" | jq -r --arg d "$VPC_DESC" --arg r "$REGION" '.vpcs[] | select(.description==$d and .region==$r) | .id' | head -n1)
if [[ -z $VPC_ID ]]; then
  VPC_ID=$(api POST /vpcs "$(jq -n --arg r "$REGION" --arg d "$VPC_DESC" --arg s "$VPC_SUBNET" --argjson m "$VPC_MASK" \
    '{region:$r, description:$d, v4_subnet:$s, v4_subnet_mask:$m}')" | jq -r '.vpc.id')
  log "created vpc $VPC_ID"
else
  log "vpc exists $VPC_ID"
fi

# ---------------------------------------------------------------- firewall groups
fw_group() { # fw_group DESCRIPTION -> id
  local id
  id=$(api GET "/firewalls?per_page=500" | jq -r --arg d "$1" '.firewall_groups[] | select(.description==$d) | .id' | head -n1)
  if [[ -z $id ]]; then
    id=$(api POST /firewalls "$(jq -n --arg d "$1" '{description:$d}')" | jq -r '.firewall_group.id')
    log "created firewall group $1 = $id"
  else
    log "firewall group exists $1 = $id"
  fi
  echo "$id"
}
fw_rule() { # fw_rule GROUP_ID IP_TYPE SUBNET SIZE PORT NOTES  (skips if an identical rule exists)
  local g=$1 t=$2 s=$3 z=$4 p=$5 n=$6 exists
  exists=$(api GET "/firewalls/$g/rules?per_page=500" | jq -r --arg t "$t" --arg s "$s" --argjson z "$z" --arg p "$p" \
    '[.firewall_rules[] | select(.ip_type==$t and .subnet==$s and .subnet_size==$z and .port==$p and .protocol=="tcp")] | length')
  if [[ $exists == 0 ]]; then
    api POST "/firewalls/$g/rules" "$(jq -n --arg t "$t" --arg s "$s" --argjson z "$z" --arg p "$p" --arg n "$n" \
      '{ip_type:$t, protocol:"tcp", subnet:$s, subnet_size:$z, port:$p, notes:$n}')" >/dev/null
    log "rule added: $g $t $s/$z tcp/$p ($n)"
  fi
}

APP_FW_ID=$(fw_group "$APP_FW")
fw_rule "$APP_FW_ID" v4 0.0.0.0 0 80  "http any v4"
fw_rule "$APP_FW_ID" v6 ::      0 80  "http any v6"
fw_rule "$APP_FW_ID" v4 0.0.0.0 0 443 "https any v4"
fw_rule "$APP_FW_ID" v6 ::      0 443 "https any v6"
fw_rule "$APP_FW_ID" v4 "$OPERATOR_IP" 32 22 "ssh operator"

SANDBOX_FW_ID=$(fw_group "$SANDBOX_FW")
fw_rule "$SANDBOX_FW_ID" v4 "$OPERATOR_IP" 32 22 "ssh operator"

# ---------------------------------------------------------------- instances
instance() { # instance LABEL FW_ID -> id
  local label=$1 fw=$2 id body
  id=$(api GET "/instances?per_page=500&label=$label" | jq -r --arg l "$label" '.instances[] | select(.label==$l) | .id' | head -n1)
  if [[ -z $id ]]; then
    body=$(jq -n --arg r "$REGION" --arg p "$PLAN" --argjson os "$OS_ID" --arg l "$label" --arg k "$SSHKEY_ID" \
      --arg v "$VPC_ID" --arg f "$fw" \
      '{region:$r, plan:$p, os_id:$os, label:$l, hostname:$l, sshkey_id:[$k], backups:"disabled",
        enable_ipv6:true, attach_vpc:[$v], firewall_group_id:$f, activation_email:false, tags:["logless"]}')
    # Only keep the id: the create response contains default_password, never print it.
    id=$(api POST /instances "$body" | jq -r '.instance.id')
    log "created instance $label = $id"
  else
    log "instance exists $label = $id"
  fi
  echo "$id"
}
APP_ID=$(instance logless-app "$APP_FW_ID")
SANDBOX_ID=$(instance logless-sandbox "$SANDBOX_FW_ID")

wait_active() { # wait_active ID -> prints "main_ip internal_ip v6_main_ip"
  local id=$1 j
  for _ in $(seq 1 90); do
    j=$(api GET "/instances/$id")
    if [[ $(jq -r '.instance.status' <<<"$j") == active && $(jq -r '.instance.power_status' <<<"$j") == running \
          && $(jq -r '.instance.main_ip' <<<"$j") != 0.0.0.0 ]]; then
      jq -r '.instance | "\(.main_ip) \(.internal_ip) \(.v6_main_ip)"' <<<"$j"; return 0
    fi
    sleep 10
  done
  echo "instance $id did not become active" >&2; return 1
}
read -r APP_IP APP_PRIV_IP APP_IP6 < <(wait_active "$APP_ID")
read -r SANDBOX_IP SANDBOX_PRIV_IP SANDBOX_IP6 < <(wait_active "$SANDBOX_ID")

# internal_ip can lag behind; re-read the VPC attachment if empty
vpc_ip() { api GET "/instances/$1/vpcs" | jq -r --arg v "$VPC_ID" '.vpcs[] | select(.id==$v) | .ip_address' | head -n1; }
[[ -n $APP_PRIV_IP && $APP_PRIV_IP != null ]] || APP_PRIV_IP=$(vpc_ip "$APP_ID")
[[ -n $SANDBOX_PRIV_IP && $SANDBOX_PRIV_IP != null ]] || SANDBOX_PRIV_IP=$(vpc_ip "$SANDBOX_ID")

# ---------------------------------------------------------------- wait for SSH
wait_ssh() {
  for _ in $(seq 1 60); do
    ssh -i "$SSH_PRIV" -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "root@$1" true 2>/dev/null && return 0
    sleep 5
  done
  echo "ssh to $1 never came up" >&2; return 1
}
wait_ssh "$APP_IP"; wait_ssh "$SANDBOX_IP"

cat >"$OUT" <<EOF
# Generated by infra/provision.sh — resource IDs and addresses only, no secrets.
REGION=$REGION
PLAN=$PLAN
OS_ID=$OS_ID
OPERATOR_IP=$OPERATOR_IP
SSHKEY_ID=$SSHKEY_ID
VPC_ID=$VPC_ID
VPC_SUBNET=$VPC_SUBNET/$VPC_MASK
APP_FW_ID=$APP_FW_ID
SANDBOX_FW_ID=$SANDBOX_FW_ID
APP_ID=$APP_ID
APP_IP=$APP_IP
APP_IP6=$APP_IP6
APP_PRIV_IP=$APP_PRIV_IP
APP_HOST=${APP_IP//./-}.sslip.io
SANDBOX_ID=$SANDBOX_ID
SANDBOX_IP=$SANDBOX_IP
SANDBOX_IP6=$SANDBOX_IP6
SANDBOX_PRIV_IP=$SANDBOX_PRIV_IP
EOF
log "wrote $OUT"
cat "$OUT"
