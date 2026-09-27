"""Runner settings, read once from the environment (systemd EnvironmentFile on the VM)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# Hard limits from docs/CONTRACTS.md §9. Requests beyond these are rejected, never clamped.
MAX_CODE_BYTES = 64 * 1024
MAX_FILES_BYTES = 8 * 1024 * 1024
MAX_FILES = 8
MAX_TIMEOUT_S = 10.0
MIN_TIMEOUT_S = 0.5
MAX_MEMORY_MB = 512
MIN_MEMORY_MB = 128
MAX_OUTPUT_BYTES = 1024 * 1024          # /out/result.json cap
MAX_STREAM_BYTES = 64 * 1024            # bounded capture per stream
STDERR_TAIL_BYTES = 2 * 1024            # what the API returns (backend-only)
MAX_REQUEST_BYTES = 10 * 1024 * 1024    # JSON envelope around ≤ 8 MiB of files

# Container limits (fixed; the request may only lower memory and the deadline).
CPUS = 1
PIDS = 64
SANDBOX_UID = 10001
TMP_TMPFS = "size=64m,nr_inodes=1024"
OUT_TMPFS = "size=2m,nr_inodes=16,mode=0700,uid=10001,gid=10001"


@dataclass(frozen=True)
class Settings:
    token: str
    bind: str
    runtime: str
    image: str
    image_digest: str
    work_dir: Path
    concurrency: int
    result_ttl_s: int
    docker_bin: str
    tmp_tmpfs: str
    out_tmpfs: str

    @property
    def host(self) -> str:
        return self.bind.rsplit(":", 1)[0]

    @property
    def port(self) -> int:
        return int(self.bind.rsplit(":", 1)[1])


def load() -> Settings:
    token = os.environ.get("RUNNER_TOKEN", "")
    return Settings(
        token=token,
        bind=os.environ.get("RUNNER_BIND", "127.0.0.1:8787"),
        runtime=os.environ.get("RUNNER_RUNTIME", "runsc"),
        image=os.environ.get("RUNNER_IMAGE", "logless-analysis:1"),
        # Optional expected image id ("sha256:…"). If set and the tag resolves to anything else,
        # the runner refuses to run jobs (health reports "degraded").
        image_digest=os.environ.get("RUNNER_IMAGE_DIGEST", ""),
        work_dir=Path(os.environ.get("RUNNER_WORK_DIR", "/var/lib/logless-runner/jobs")),
        concurrency=max(1, int(os.environ.get("RUNNER_CONCURRENCY", "2"))),
        result_ttl_s=int(os.environ.get("RUNNER_RESULT_TTL_S", "900")),
        docker_bin=os.environ.get("RUNNER_DOCKER", "docker"),
        # Overridable only in case a runtime rejects a tmpfs option; the defaults are the contract.
        tmp_tmpfs=os.environ.get("RUNNER_TMP_TMPFS", TMP_TMPFS),
        out_tmpfs=os.environ.get("RUNNER_OUT_TMPFS", OUT_TMPFS),
    )
