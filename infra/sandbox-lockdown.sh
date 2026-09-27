#!/usr/bin/env bash
# Egress lockdown for logless-sandbox. Run as root ON the sandbox VM:
#   ssh -F infra/ssh_config logless-sandbox 'bash -s' < infra/sandbox-lockdown.sh
#
# Installs a dedicated nftables table (inet logless_lockdown) via a systemd oneshot unit so it
# survives reboots and coexists with Docker's own tables (no global `flush ruleset`).
#   inbound : lo, established/related, ICMP/ICMPv6, DHCPv4/v6 replies, TCP 22 on the public NIC only
#             (the Vultr firewall group limits it to the operator IP; SSH over the VPC is refused),
#             TCP 8787 only from the app VM private IP.
#   outbound: lo, established/related, the VPC subnet, DHCPv4/v6 (keeps the public lease alive),
#             169.254.169.254 (Vultr link-local metadata + DHCP server, used by cloud-init at boot),
#             ICMP errors / ICMPv6 neighbour discovery. Everything else drops: internet, DNS, NTP,
#             apt, docker pull.
#   forward : drop (containers run with --network=none; bridge-networked containers get nothing).
# Undo temporarily with sandbox-unlock.sh; a reboot or re-running this script re-locks.
#
# ROLLBACK_SECS=N (optional): auto-remove the table after N seconds unless you cancel with
#   systemctl stop logless-lockdown-rollback.timer   (dead-man switch for the first apply)
set -euo pipefail

APP_PRIV_IP=${APP_PRIV_IP:-10.20.0.3}
VPC_SUBNET=${VPC_SUBNET:-10.20.0.0/24}
RUNNER_PORT=${RUNNER_PORT:-8787}
PUBLIC_IF=${PUBLIC_IF:-$(ip -4 route show default | awk '{print $5; exit}')}
METADATA_IP=169.254.169.254
[[ -n $PUBLIC_IF ]] || { echo "could not detect public interface" >&2; exit 1; }
NFT_FILE=/etc/logless-lockdown.nft
UNIT=/etc/systemd/system/logless-lockdown.service

command -v nft >/dev/null || { echo "nftables not installed (apt-get install nftables while unlocked)" >&2; exit 1; }

cat >"$NFT_FILE" <<EOF
#!/usr/sbin/nft -f
# Managed by infra/sandbox-lockdown.sh — logless sandbox egress lockdown.
table inet logless_lockdown
delete table inet logless_lockdown

table inet logless_lockdown {
	chain input {
		type filter hook input priority filter; policy drop;
		iif "lo" accept
		ct state established,related accept
		ct state invalid drop
		meta l4proto { icmp, ipv6-icmp } accept
		udp sport 67 udp dport 68 accept
		udp sport 547 udp dport 546 accept
		iifname "$PUBLIC_IF" tcp dport 22 accept
		ip saddr $APP_PRIV_IP tcp dport $RUNNER_PORT accept
	}

	chain forward {
		type filter hook forward priority filter; policy drop;
		ct state established,related accept
	}

	chain output {
		type filter hook output priority filter; policy drop;
		oif "lo" accept
		ct state established,related accept
		ip daddr $VPC_SUBNET accept
		ip daddr $METADATA_IP accept
		udp sport 68 udp dport 67 accept
		udp sport 546 udp dport 547 accept
		icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, echo-reply } accept
		icmp type { echo-reply, destination-unreachable, time-exceeded } accept
	}
}
EOF
chmod 644 "$NFT_FILE"
nft -c -f "$NFT_FILE"   # syntax check before touching live rules

cat >"$UNIT" <<EOF
[Unit]
Description=logless sandbox egress lockdown (nftables table inet logless_lockdown)
DefaultDependencies=no
Before=network-pre.target docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $NFT_FILE
ExecStop=-/usr/sbin/nft delete table inet logless_lockdown

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable logless-lockdown.service >/dev/null
systemctl restart logless-lockdown.service

if [[ -n ${ROLLBACK_SECS:-} ]]; then
  systemctl stop logless-lockdown-rollback.timer 2>/dev/null || true
  systemd-run --unit logless-lockdown-rollback --on-active="$ROLLBACK_SECS" \
    /usr/sbin/nft delete table inet logless_lockdown >/dev/null
  echo ">> rollback armed in ${ROLLBACK_SECS}s; cancel: systemctl stop logless-lockdown-rollback.timer"
fi

echo ">> lockdown active"
nft list table inet logless_lockdown
