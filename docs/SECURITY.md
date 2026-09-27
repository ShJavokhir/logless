# Containment and safety

Track 1 asks for "containment-first" execution: **process isolation, secret hygiene, resource limits and lifecycle discipline**. This page maps each of those to what logless does, and records a hostile-program battery run against the **deployed** gVisor sandbox on Vultr (Sep 27, 2026, 04:20 UTC). The script is `backend/scripts/hostile_battery.py`; run it on the app VM to reproduce.

The battery was run before later app-side changes. The containment check in the web app re-runs the runaway, destructive and leak checks against the live deployment on demand.

## What runs where

- **App VM:** holds the model API keys and the private data. It never runs agent-written code.
- **Sandbox VM:** holds no API keys or cloud credentials; its only secret is the runner's own auth token. Its outbound traffic is locked to the private VPC (nftables). The runner listens only on the VPC address, behind a bearer token.
- **Per job:** a fresh `docker --runtime=runsc` (gVisor) container with:
  - `--network=none`
  - a read-only root filesystem
  - a non-root user (uid 10001)
  - `--cap-drop=ALL` and `no-new-privileges`
  - 1 vCPU, 512 MiB of memory with no swap, and a 64-process limit
  - a 64 MiB `/tmp` and a 2 MiB `/out`
  - `core=0`, `nofile=256`, and no Docker log driver
  - a wall-clock deadline enforced from outside

  The container is removed after every run, and removal is verified. If removal can't be confirmed, the runner quarantines itself.
- **What gets out:** only a JSON result that passes the egress gate on the app VM. The gate enforces:
  - strict parsing and structural limits;
  - an allowlisted schema;
  - no per-person rows;
  - consistency with the published map.

  Sandbox stdout and stderr never reach the browser or a repair prompt.

## Hostile-program battery (deployed sandbox, runsc)

| Attack | Outcome | Container removed |
|---|---|---|
| `rm -rf --no-preserve-root /` | Root-image deletion refused. `rm` exits 1 after about 11,000 refused removals: the root filesystem is read-only (`can_write_root: false`), the program isn't root, and the Python binary was still present. Disposable writable tmpfs paths can be changed; this is not a claim that no container-local file was removed. This also runs in the product's containment check (below). | yes |
| Fork bomb | Refused by the 64-process limit; the job failed in 1.6 s. | yes |
| Memory bomb (2 GiB) | Killed at the 512 MiB cap (exit 137). | yes |
| Disk fill | `/tmp` filled at 64 MiB, then `OSError`. | yes |
| Network exfiltration | Internet, cloud metadata `169.254.169.254` and the app VM `10.20.0.3:8000` all returned `Network is unreachable`, and DNS failed. | yes |
| Secret hunting | The environment holds only the Python image defaults. `GPG_KEY` is the public Python release-signing key ID, not a secret. There are no secret files and no Docker socket, and PID 1's environment matches. | yes |
| Host escape probes | The kernel is `4.19.0-gvisor` (gVisor's user-space kernel), running as uid 10001 with `CapEff 0000000000000000`. `setuid(0)`, `mount`, `/proc/sysrq-trigger`, and writing to the read-only `/in` were all denied. | yes |
| Runaway loop (in the product) | Killed at its 2,000 ms deadline, at about 2.1 s measured. The app stays healthy and a follow-up run passes. | yes |
| `rm -rf /` (in the product) | A fixed fixture runs it in a fresh container: `rm` exits 1 with about 11,000 removals refused, the container is removed, and the next run from the same pinned image passes. The fixture refuses to run anywhere but inside the gVisor sandbox, so it can't damage a developer machine. | yes |
| Per-person leak attempt (in the product) | Rejected by the egress gate ("Only allowlisted field names", "Schema matches exactly"). | yes |

The runner reported healthy after the battery.

## What the agent can and cannot do

- The analysis agent's only capability is writing a Python program over typed, text-free rows. It has no tools to send, delete, buy or browse.
- The browser can't submit code. Containment checks run fixed, version-controlled fixtures.
- **The one state-changing feature is Live intake,** which republishes the map with new conversations. It is presenter-only and reversible (`POST /api/intake/reset`).
- Public endpoints are rate-limited per IP and have global hourly budgets, so anonymous traffic can't run up model costs.

## Limits (stated honestly)

- gVisor greatly reduces the kernel attack surface, but this is not a proof against every container escape.
- The sandbox VM's host allows DHCP and Vultr metadata traffic; the containers have no network at all.
- The model providers (Vultr Serverless Inference, TypeSafe, Fireworks) process raw text or facets on the app side. This is not differential privacy.
