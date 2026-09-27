# logless infrastructure (Vultr)

Two Ubuntu 24.04 VMs in Vultr **sjc** (Silicon Valley) on a private VPC:

- **logless-app**: Caddy (HTTPS) → FastAPI on `127.0.0.1:8000`, static SPA, SQLite. It holds the model keys (deployed separately from `.env`).
- **logless-sandbox**: a box with no API keys or cloud credentials (its only secret is the runner's auth token) that runs untrusted analysis code in **gVisor (runsc, systrap)** containers. Its egress is locked down to the VPC. The runner will listen on `10.20.0.4:8787`, and only the app VM can reach that port.

Provisioned and verified on 2026-09-26 (PDT). Resource IDs and addresses are also in [`resources.env`](resources.env), which `provision.sh` generates.

## What exists

| Resource | Name | ID | Details |
|---|---|---|---|
| SSH key | `logless` | `3653e190-4832-44d8-ac67-0f4af5e26664` | `~/.ssh/logless_vultr.pub` |
| VPC | `logless-vpc` | `789ae7cf-d480-435f-b2c4-2cab59b8c716` | sjc, `10.20.0.0/24` |
| Firewall group | `logless-app-fw` | `4d140f7a-39ee-4ab2-960b-564803ee14ff` | TCP 80, 443 from `0.0.0.0/0` + `::/0`; TCP 22 from `<operator-ip>/32` only |
| Firewall group | `logless-sandbox-fw` | `9f8ec92c-1f08-48fe-8ce8-681517677eb4` | TCP 22 from `<operator-ip>/32` only; nothing else public |
| Instance | `logless-app` | `a9d8a072-8e9e-4e14-9535-1eec72983a19` | vc2-4c-8gb (4 vCPU / 8 GB / 160 GB), os_id 2284 (Ubuntu 24.04), backups off |
| Instance | `logless-sandbox` | `b3f19b81-e975-45d2-a77d-0c8da340f158` | vc2-4c-8gb, os_id 2284, backups off |

| VM | Public IPv4 | Public IPv6 | VPC IP (enp8s0) |
|---|---|---|---|
| logless-app | `144.202.110.2` | `2001:19f0:ac00:42ef:5400:06ff:febe:e0d5` | `10.20.0.3` |
| logless-sandbox | `149.28.223.172` | `2001:19f0:ac01:14d3:5400:06ff:febe:e0da` | `10.20.0.4` |

- **Public URL:** https://144-202-110-2.sslip.io/. It uses a Let's Encrypt cert (issuer `YE2`, valid Sep 26 to Dec 25 2026), which Caddy renews automatically.
- **Cost:** each VM is $40/month ($0.055/hr), so about $2.64/day for both, paid from the $200 credit.

## Access

```bash
ssh -F infra/ssh_config logless-app
ssh -F infra/ssh_config logless-sandbox
```

SSH is allowed only from the operator IP `<operator-ip>` (Vultr firewall groups). **If your public IP changes**, you lose SSH until you update the rule. Either re-run `provision.sh` with the new IP (it adds a rule for the current IP; delete the stale one in the dashboard), or update it by API:

```bash
set -a; source .env.ops; set +a
FW=4d140f7a-39ee-4ab2-960b-564803ee14ff   # repeat for 9f8ec92c-1f08-48fe-8ce8-681517677eb4
curl -sS -H "Authorization: Bearer $VULTR_API_KEY" https://api.vultr.com/v2/firewalls/$FW/rules | jq '.firewall_rules[] | select(.port=="22")'
curl -sS -X POST -H "Authorization: Bearer $VULTR_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"ip_type\":\"v4\",\"protocol\":\"tcp\",\"subnet\":\"$(curl -s https://api.ipify.org)\",\"subnet_size\":32,\"port\":\"22\",\"notes\":\"ssh operator\"}" \
  https://api.vultr.com/v2/firewalls/$FW/rules
# then: DELETE https://api.vultr.com/v2/firewalls/$FW/rules/<old-rule-id>
```

## Files

| File | Purpose |
|---|---|
| `provision.sh` | Vultr API v2 calls: SSH key, VPC, firewall groups and rules, both instances. It looks everything up by name first, so it's safe to re-run. Needs `VULTR_API_KEY` from the env and never prints the instance `default_password`. Writes `resources.env`. |
| `setup-app.sh` | App VM bootstrap (run as root on the VM). |
| `Caddyfile` | Caddy site template; `__LOGLESS_HOST__` is substituted by `setup-app.sh`. |
| `setup-sandbox.sh` | Sandbox VM bootstrap: Docker, gVisor, runner user, image build. |
| `sandbox-image/Dockerfile` | `logless-analysis:1`: digest-pinned `python:3.12-slim` + pandas 2.2.3 + numpy 2.1.3, uid 10001. |
| `sandbox-smoke.sh` | gVisor smoke tests (sections 1–7 below). |
| `sandbox-lockdown.sh` / `sandbox-unlock.sh` | Sandbox egress lockdown (nftables) and temporary unlock. |
| `ssh_config` | Host aliases (not included from `~/.ssh/config`). |

The Vultr API key (`.env.ops`) is used only from the operator's Mac. It was never copied to either VM and never written into `infra/`.

## Provisioning

```bash
set -a; source .env.ops; set +a
./infra/provision.sh          # OPERATOR_IP=... to override the SSH allow-list IP
```

The instance create call uses `attach_vpc: [<vpc>]`, `firewall_group_id`, `sshkey_id`, `backups: "disabled"`, `enable_ipv6: true` and `activation_email: false`. Attaching the VPC at create time let cloud-init configure the second NIC by itself: `enp8s0` got `10.20.0.x/24` with MTU 1450 in `/etc/netplan/50-cloud-init.yaml`, so no manual netplan work was needed.

## App VM (`logless-app`)

```bash
scp -F infra/ssh_config infra/setup-app.sh infra/Caddyfile logless-app:/root/
ssh -F infra/ssh_config logless-app 'LOGLESS_HOST=144-202-110-2.sslip.io bash /root/setup-app.sh'
```

What the script does:
- Runs apt update/upgrade and installs `python3.12` (3.12.3) with `python3.12-venv`, `sqlite3` (3.45.1), `git`, `rsync` and `unattended-upgrades` (enabled via `20auto-upgrades`).
- Installs Caddy **v2.11.4** from the official cloudsmith apt repo.
- Installs `uv` **0.12.19** to `/usr/local/bin` with the astral installer.
- Creates the system user `logless` (uid 996, nologin, home `/var/lib/logless`) and these directories:
  - `/opt/logless` (code): `logless:logless 755`. 755 so Caddy can read `web/dist`.
  - `/var/lib/logless` (data): `logless:logless 750`.
  - `/etc/logless` (env files): `root:logless 750`.
- Writes the placeholder page `/opt/logless/web/dist/index.html` ("logless — deploying").
- **ufw:** Vultr's Ubuntu image ships with **ufw enabled, allowing only 22/tcp**. The script adds `80/tcp` and `443/tcp`, keeping ufw as a second layer behind the Vultr firewall group. The first ACME attempt failed because of this (`Timeout during connect (likely firewall problem)`). Once the ports were open, Caddy's retry got the cert.

Caddy routes `/api/*` to `reverse_proxy 127.0.0.1:8000`. Everything else is served from `/opt/logless/web/dist` with `try_files {path} /index.html`. It also:
- Compresses with `encode zstd gzip`.
- Sets HSTS, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a Permissions-Policy and a CSP (`default-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `frame-ancestors 'none'`).
- Strips the `Server` header.
- Marks `/assets/*` as immutable and `index.html` as `no-cache`.
- Disables HTTP/3, because the firewall doesn't open UDP 443.

Verified from the Mac:
```
$ curl -sI https://144-202-110-2.sslip.io/          -> HTTP/2 200, all headers above present
$ openssl s_client ... | openssl x509 -issuer ...   -> issuer=C=US, O=Let's Encrypt, CN=YE2; Verify return code: 0 (ok)
$ curl -sI http://144-202-110-2.sslip.io/           -> HTTP/1.1 308 Permanent Redirect -> https://
$ curl https://144-202-110-2.sslip.io/some/client/route -> 200 text/html (SPA fallback)
$ curl https://144-202-110-2.sslip.io/api/health    -> 502 (expected: no backend on :8000 yet)
$ curl -6 https://144-202-110-2.sslip.io/           -> 200 (IPv6 works)
$ 8 KB test file, Accept-Encoding zstd / gzip        -> content-encoding: zstd / gzip
  (the 307-byte placeholder is below Caddy's 512-byte minimum, so it is sent uncompressed)
```
After a reboot, the app VM came back on kernel `6.8.0-142-generic`, Caddy was active and HTTPS returned 200 with a valid cert.

## Sandbox VM (`logless-sandbox`)

```bash
# needs outbound network: run before lockdown, or inside an unlock window
scp -F infra/ssh_config -r infra/setup-sandbox.sh infra/sandbox-image logless-sandbox:/root/
ssh -F infra/ssh_config logless-sandbox 'bash /root/setup-sandbox.sh'
```

What the script does:
- Runs apt update/upgrade and installs `python3.12` with venv, `uv` 0.12.19, `nftables` and `unattended-upgrades`.
- **Disables ufw.** The nftables lockdown table is the single host ruleset here. ufw's default-deny would otherwise also block 8787 from the VPC.
- Installs Docker Engine **29.8.1** from the official `download.docker.com` apt repo.
- Installs gVisor **`runsc release-20260921.0`** from the official gVisor apt repo, then runs `runsc install -- --platform=systrap` and restarts Docker. That produces this `/etc/docker/daemon.json`:
  ```json
  { "runtimes": { "runsc": { "path": "/usr/bin/runsc", "runtimeArgs": ["--platform=systrap"] } } }
  ```
- **Platform:** systrap, gVisor's default, worked first try on Vultr's `6.8.0-139-generic` kernel. The KVM platform is not an option because vc2 has no nested virtualization (0 `vmx`/`svm` flags in `/proc/cpuinfo`). ptrace was not needed.
- Creates the system user `runner` (uid 999, member of `docker`) and `/opt/logless-runner` (`runner:runner 750`). Note that `docker` group membership is root-equivalent on this host. That is acceptable only because the box holds no API keys or cloud credentials; the runner's auth token is its only secret.
- Builds `logless-analysis:1` (image ID `sha256:91c87e91583e…`, 376 MB) from `sandbox-image/Dockerfile`:
  - Base: `python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f`, which is Python 3.12.14 on Debian 13.
  - pandas 2.2.3 and numpy 2.1.3.
  - User `sandbox` 10001:10001, `WORKDIR /work`, `HOME=/tmp`.

### Smoke tests (gVisor)

`ssh -F infra/ssh_config logless-sandbox 'bash -s' < infra/sandbox-smoke.sh`. Every test uses the hardened flag set:

```
--runtime=runsc --network=none --read-only --tmpfs /tmp:rw,size=64m --cap-drop=ALL
--security-opt=no-new-privileges --pids-limit=64 --memory=512m --memory-swap=512m --cpus=1 --user 10001:10001
```

The observed output below is from the run with the **lockdown active**. The unlocked runs gave the same results, with timings within about 0.15 s; for example, `import pandas` took 2.22 s unlocked.

**1. Hardened run.** `docker run --rm <flags> logless-analysis:1 python -c "import pandas, numpy; print('ok', pandas.__version__)"`
```
ok 2.2.3
exit=0
```

**2. It really is gVisor.** The same image reports a synthetic kernel under runsc and the host kernel under runc:
```
-- dmesg inside runsc:
[    0.000000] Starting gVisor...
[    0.588731] Deleting VFS and rebuilding it from scratch...
...
[    3.306324] Ready!
-- uname -a inside runsc:
Linux d5014265ca95 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016 x86_64 GNU/Linux
-- same image under runc for comparison:
6.8.0-139-generic
```

**3. Network is off.**
```
$ python -c "import socket; print(socket.if_nameindex())"                 -> interfaces: [(1, 'lo')]
$ python -c "import socket; socket.create_connection(('1.1.1.1',53),2)"   -> OSError: [Errno 101] Network is unreachable (exit=1)
```

**4. Runaway kill after 2.0 s.**
```bash
name=logless-runaway-$(date +%s%N)
timeout --signal=KILL 2.0 docker run --rm --name "$name" <flags> logless-analysis:1 python -c "while True: pass"
docker rm -f "$name"
docker ps -a --filter "name=^${name}$"     # -> empty
```
The container was still running when the deadline hit, and `docker rm -f` killed and removed it:
```
container=logless-runaway-1790469294154400606 timeout_rc=137 state_at_deadline=[running pid=16644]
deadline_fired_after=2.004s  docker_rm_f_took=0.160s  total_elapsed=2.164s
containers left with that name: 0
no leftover runsc processes
```
Other runs took 2.153 s and 2.164 s. Killing the `docker run` client alone does **not** stop the container; the runner must always follow up with `docker rm -f <name>`.

**5. Mounts.** `-v /tmp/in:/in:ro -v /tmp/out:/out:rw`, with `/tmp/out` set to `chown 10001:10001` and `chmod 700`. `/tmp/in` is also owned by 10001, so any failed write proves the `:ro` flag blocked it rather than file permissions.
```
write to /in blocked: Read-only file system
write to rootfs (/work) blocked: Read-only file system
write to /tmp tmpfs: ok
host reads /tmp/out/result.json: {"rows": 3, "mean_latency_by_service": {"api": 100.0, "web": 200.0}}
-rw-r--r-- 1 10001 10001 68 Sep 27 00:34 result.json
```

**6. Cold-start latency.** The image was cached; each run is a full `docker run --rm` wall time.
```
runsc python -c pass : 0.291s 0.302s 0.317s 0.314s 0.307s   (first run 0.29–0.33 s across 3 sessions)
runsc import pandas  : 2.300s 2.357s
runc  python -c pass : 0.257s     runc import pandas: 1.643s
```
Budget roughly **2.3 s** of per-job overhead for a pandas script under gVisor.

**7. Memory limit.** `bytearray(1 GiB)` in the 512m container exits with **137** (OOM-killed).

### VPC connectivity

Before lockdown, from the app VM: ping to `10.20.0.4` got 3/3 replies with a 0.85 ms average; `nc -zv 10.20.0.4 22` succeeded; and `curl http://10.20.0.4:8787/` against `python3 -m http.server 8787 --bind 10.20.0.4` returned the page. The route is `10.20.0.4 dev enp8s0 src 10.20.0.3`. From the Mac, the sandbox's public `:8787` times out (Vultr firewall).

## Sandbox egress lockdown

Apply it last, after anything that needs the internet (apt, docker build/pull, uv/pip installs):

```bash
ssh -F infra/ssh_config logless-sandbox 'bash -s' < infra/sandbox-lockdown.sh
# first time, with a dead-man switch that auto-unlocks unless cancelled:
ssh -F infra/ssh_config logless-sandbox 'ROLLBACK_SECS=300 bash -s' < infra/sandbox-lockdown.sh
ssh -F infra/ssh_config logless-sandbox 'systemctl stop logless-lockdown-rollback.timer'
```

The script installs a dedicated nftables table, `inet logless_lockdown`, in `/etc/logless-lockdown.nft`. It is loaded by `logless-lockdown.service` (enabled, ordered before `network-pre.target` and `docker.service`). There is no global `flush ruleset`, so it coexists with Docker's iptables-nft tables.

| Chain | Policy | Allowed |
|---|---|---|
| input | drop | `lo`; established/related; ICMP/ICMPv6; DHCPv4/v6 replies; **TCP 22 only on the public NIC** `enp1s0` (the Vultr firewall pins it to the operator IP, so SSH over the VPC is refused); **TCP 8787 only from `10.20.0.3`** |
| output | drop | `lo`; established/related; `10.20.0.0/24`; `169.254.169.254` (Vultr link-local metadata and DHCP server, which cloud-init and DHCP need to keep the public IP); DHCPv4/v6; ICMP errors; ICMPv6 neighbour discovery |
| forward | drop | established/related only |

Verified with the lockdown active:
```
[sandbox] curl -m 5 https://example.com     -> curl: (6) Could not resolve host (exit 6)
[sandbox] curl -m 5 http://1.1.1.1          -> curl: (28) Connection timed out (exit 28)
[sandbox] getent hosts example.com         -> exit 2;  docker pull alpine:3 -> exit 1
[sandbox] ping 10.20.0.3 (VPC)             -> ok
[app]     curl http://10.20.0.4:8787/       -> "runner-port reachable"
[app]     curl http://10.20.0.4:8788/       -> curl: (28) Connection timed out
[app]     nc -zv 10.20.0.4 22               -> timed out (SSH over VPC refused)
[mac]     curl http://149.28.223.172:8787/  -> timed out
[mac]     ssh logless-sandbox (new session) -> ok
all 7 gVisor smoke tests pass while locked
```
After a **reboot** of the sandbox, `logless_lockdown` was loaded at boot, both IPs came back (the DHCP lease on the public IP and the VPC IP), Docker and runsc worked (`runsc ok 4.19.0-gvisor 2.2.3`), egress stayed blocked, the app VM could still reach `:8787`, and no units had failed.

### Unlock / relock

```bash
# lift temporarily (the unit stays enabled, so a reboot re-locks); optional auto-relock:
ssh -F infra/ssh_config logless-sandbox 'RELOCK_AFTER=900 bash -s' < infra/sandbox-unlock.sh
# ... apt-get upgrade / docker build / uv sync ...
ssh -F infra/ssh_config logless-sandbox 'systemctl start logless-lockdown.service; systemctl stop logless-relock.timer 2>/dev/null; true'
```
Verified: when unlocked, `curl https://example.com` returned 200. After relocking, curl failed again with exit 6.

## Known limitations / follow-ups

- **Backend routes must live under `/api`:** `handle /api/*` + `reverse_proxy` does not strip the prefix, so FastAPI must serve `/api/...` on `127.0.0.1:8000`. Bind uvicorn to loopback only.
- **Runner dependencies:** install anything the runner needs (a uv venv in `/opt/logless-runner`) inside an unlock window, or rsync pre-built wheels over the VPC from the app VM.
- While the sandbox is locked, **unattended-upgrades and NTP (timesyncd) cannot reach the internet**. This is expected. Run an unlock window to patch. Clock drift on KVM with kvm-clock is small over the hackathon timeframe. A possible follow-up is to serve NTP from the app VM over the VPC with chrony.
- The sandbox host itself can reach the Vultr metadata service at `169.254.169.254`, which is needed for DHCP and cloud-init. Containers cannot, because they run with `--network=none` and forwarding is dropped. No user-data or secrets were set on the instances.
- **The app VM's ufw allows 22 from anywhere at the host level,** but the Vultr firewall group only lets `<operator-ip>` through.
- **Re-provisioning with a new public IP** changes the sslip hostname (`<ip-with-dashes>.sslip.io`). Pass the new `LOGLESS_HOST` to `setup-app.sh`.
- **Teardown:** delete both instances, then the firewall groups, the VPC and the SSH key through the API or dashboard (IDs above). Nothing was torn down.
