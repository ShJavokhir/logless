# logless-runner

The sandbox runner for logless (docs/CONTRACTS.md §9). It runs on the sandbox VM, which holds no API keys or cloud credentials (only this runner's auth token),
listens only on the VPC address, and executes one program per job in a fresh, network-less gVisor
container that is always destroyed afterwards. It holds **no API keys**: the only secret is
`RUNNER_TOKEN`, a random bearer token shared with the app VM (not a cloud credential).

## API

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /jobs` | bearer (checked on headers, before the body is read) | `{job_id (uuid), kind: analysis\|aggregate\|containment, code (≤ 64 KiB), files: {name: content} (≤ 8 MiB; names from {assignments.csv, clusters.json, contract.json}), timeout_s (0.5–10), memory_mb (128–512)}` → `202 {job_id, state}`. Idempotent on `job_id` (a different job under the same id → 409). Queue full → 503. |
| `GET /jobs/{job_id}` | bearer | `{job_id, kind, state, exit_code, started_at, finished_at, elapsed_ms, timed_out, container_removed, runtime, image, output, output_bytes, stderr_tail, error, host, code_sha256, limits}`. Results are kept in memory for `RUNNER_RESULT_TTL_S` (15 min). |
| `GET /health` | none | `{status: ok\|degraded, quarantined, runtime, image, docker, queued}` — no config values. |

`state` is `queued | running | succeeded | failed | timed_out`; a job becomes terminal only after
its container has been removed and the removal verified. If removal cannot be verified, the job
fails with `cleanup_failed` (never `succeeded`, no output) and the runner quarantines itself: new
jobs get `503 quarantined`, queued jobs wait, `/health` reports `degraded` with `quarantined: n`,
and a reconcile loop retries the removal every 5 s until docker confirms it. Labelled orphans that
belong to no running job are swept every minute (and on startup). `error` is a fixed code
(`timeout`, `nonzero_exit`, `oom_killed`, `no_output`, `output_too_large`,
`output_not_regular_file`, `too_many_output_files`, `output_unreadable`, `not_utf8`, `bad_output_frame`,
`container_create_failed`, `image_missing`, `image_digest_mismatch`, `runtime_unavailable`,
`runner_error`, `cleanup_failed`). `stderr_tail` (≤ 2 KiB) is for the backend only and never reaches a browser.

## How a job runs

1. The runner writes `/in` on the host (`$RUNNER_WORK_DIR/<job>/in`, mode 0755/0644): the input
   files, the program as `program.py`, and a runner-owned bootstrap as `main.py`.
2. `docker create` with exactly these flags (image pinned by its content id `sha256:…`):
   `--runtime=$RUNNER_RUNTIME --network=none --read-only --tmpfs /tmp:size=64m,nr_inodes=1024
   --tmpfs /out:size=2m,nr_inodes=16,mode=0700,uid=10001,gid=10001 --cap-drop=ALL
   --security-opt=no-new-privileges --pids-limit=64 --memory=512m --memory-swap=512m --cpus=1
   --user 10001:10001 --ulimit core=0 --ulimit nofile=256 --log-driver=none
   --mount type=bind,source=<job>/in,target=/in,readonly --label logless.job=<job_id>`,
   command `python /in/main.py`. Default seccomp profile; no env vars from the runner (the docker
   CLI itself gets a minimal environment, so `RUNNER_TOKEN` is never visible to it).
3. `docker start -a`: the monotonic clock starts. stdout (≤ 1 MiB + frame) and stderr (64 KiB tail)
   are read through bounded pipes.
4. At the deadline the supervisor sends `docker kill` (SIGKILL) from outside; `elapsed_ms` is the
   measured time until the attach stream ends.
5. `docker inspect` (exit code, OOM flag, runtime actually used) → `docker rm -f` → verify with
   `docker ps -a --filter label=logless.job=<id>`; `container_removed` is the verified result.
6. The job directory is deleted; the result stays in memory for the TTL.

**Why a bootstrap.** `/out` is a size-capped tmpfs (2 MiB, 16 inodes) so a program cannot fill the
host disk, and a tmpfs disappears when the container stops (verified: `docker cp` after exit finds
nothing). So `main.py` runs the program (`/in/program.py`) as a child process with its stdout sent
to stderr, and after it exits streams `/out/result.json` — a regular file only (`O_NOFOLLOW`,
`S_ISREG`; no symlinks or FIFOs), at most 1 MiB — to the real stdout behind a one-line header
`LOGLESS/1 <status> <exit> <bytes>`. This is transport, not a trust boundary: a program could forge
the frame just as it could write any result. The egress gate on the app VM decides what is valid.

On startup the runner reaps any container labelled `logless.job` and clears stale job dirs.
Concurrency is `RUNNER_CONCURRENCY` (2) workers over a bounded queue (16).

## Configuration (`/etc/logless-runner/env`, root:runner 0640)

| Variable | Default | Notes |
|---|---|---|
| `RUNNER_TOKEN` | — (required) | Same value as the app VM's `RUNNER_TOKEN`. The runner refuses to start without it. |
| `RUNNER_BIND` | `127.0.0.1:8787` | On the VM: `10.20.0.4:8787` (VPC only; nftables allows 8787 only from the app VM). |
| `RUNNER_RUNTIME` | `runsc` | `runc` is allowed for local development; receipts report the runtime docker actually used. No silent fallback: if the runtime is not registered, jobs fail with `runtime_unavailable`. |
| `RUNNER_IMAGE` | `logless-analysis:1` | Resolved to its image id at startup and every 10 s. |
| `RUNNER_IMAGE_DIGEST` | empty | Optional expected image id; on mismatch the runner refuses jobs (`image_digest_mismatch`). Set on the VM to `sha256:91c87e91583e…` — after rebuilding `logless-analysis:1`, update it (`docker image inspect --format '{{.Id}}' logless-analysis:1`) and restart the runner. |
| `RUNNER_WORK_DIR` | `/var/lib/logless-runner/jobs` | Must be visible to the docker daemon (not under the unit's PrivateTmp). |
| `RUNNER_CONCURRENCY`, `RUNNER_RESULT_TTL_S` | 2, 900 | |

## Run locally (macOS, Docker Desktop, runc)

```bash
cd runner
uv sync --locked --extra dev --python 3.12
docker build -t logless-analysis:1 ../infra/sandbox-image
RUNNER_TOKEN=$(grep ^RUNNER_TOKEN= ../.env | cut -d= -f2-) RUNNER_BIND=127.0.0.1:8787 RUNNER_RUNTIME=runc \
  RUNNER_WORK_DIR=$PWD/../var-dev/runner-jobs .venv/bin/logless-runner
.venv/bin/pytest -q                       # offline tests; real Docker tests are skipped by default
```

Real Docker integration tests require explicit opt-in on a **dedicated test daemon or test VM**.
Never run them against the live demo daemon or alongside any production or development runner.
The fixture starts its own supervisor, whose orphan cleanup can remove other `logless.job`
containers. Preflight skips when any labelled container exists or inventory cannot be verified,
but an empty inventory does not prevent a concurrent runner from creating a job afterward.
Select the intended dedicated Docker context/host before opting in; do not stop or reset the live
runner to make this check pass.

```bash
# Dedicated local test daemon, with no other runner using it:
RUNNER_INTEGRATION=1 .venv/bin/pytest -q tests/test_integration.py
# Dedicated gVisor test VM, never the live demo VM:
RUNNER_INTEGRATION=1 RUNNER_IT_RUNTIME=runsc .venv/bin/pytest -q tests/test_integration.py
```

For this local setup, also start the backend with `SANDBOX_RUNTIME=runc`. The backend defaults to
`runsc` and rejects unexpected runtimes, job kinds, limits, pinned image digests and inconsistent
output byte counts. Its health is degraded if the runner reports a different runtime. The
destructive demonstration still requires gVisor and refuses to run under runc.

The bootstrap now accepts exactly one output file, `result.json`; extra output files fail the job
even when the tmpfs inode cap permits them. Startup/periodic orphan removal is verified, and failed
inventory or unverified removal prevents admission until a successful reconciliation.

If `docker pull` hangs on macOS, the Docker Desktop credential helper is waiting on the keychain;
build with `DOCKER_CONFIG=<dir with an empty config.json>` to skip it.

## Deploy (sandbox VM)

The VM is egress-locked. Build a hash-verified wheelhouse from `uv.lock`; the exact online/offline
commands and cross-platform limits are in [Reproducible Python installs](../docs/DEPENDENCIES.md).
The old unconstrained `fastapi>=...` download path must not be used for deployment.

```bash
# First prepare dist/, wheelhouse/, and requirements-runtime.txt as described in DEPENDENCIES.md.
cd runner
scp -F ../infra/ssh_config -r dist wheelhouse requirements-runtime.txt logless-runner.service README.md tests logless-sandbox:/root/runner-deploy/
# on the VM (as root):
python3.12 -m venv /opt/logless-runner/.venv
/opt/logless-runner/.venv/bin/pip install --no-index --require-hashes \
  --find-links /root/runner-deploy/wheelhouse -r /root/runner-deploy/requirements-runtime.txt
/opt/logless-runner/.venv/bin/pip install --no-index --no-deps /root/runner-deploy/dist/*.whl
/opt/logless-runner/.venv/bin/pip check
install -d -o root -g runner -m 750 /etc/logless-runner   # env file: RUNNER_TOKEN, RUNNER_BIND, RUNNER_RUNTIME
install -m 644 /root/runner-deploy/logless-runner.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now logless-runner
# from the app VM:
curl -s http://10.20.0.4:8787/health
```
