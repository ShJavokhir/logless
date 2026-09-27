"""Thin wrapper over the docker CLI (subprocess, argument lists only — never a shell).

The docker CLI gets a minimal environment, so nothing from the runner's own environment (for
example RUNNER_TOKEN) is visible to the CLI process or could be forwarded into a container."""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass

_PASS_ENV = ("PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY")


def minimal_env() -> dict[str, str]:
    env = {k: os.environ[k] for k in _PASS_ENV if os.environ.get(k)}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    return env


@dataclass
class Result:
    rc: int
    out: str
    err: str


class Docker:
    def __init__(self, binary: str = "docker"):
        self.binary = binary
        self.env = minimal_env()

    def run(self, args: list[str], timeout: float = 20.0) -> Result:
        """Run a short docker command; refuse output beyond 64 KiB rather than trust a prefix."""
        try:
            p = subprocess.run([self.binary, *args], capture_output=True, timeout=timeout, env=self.env,
                               stdin=subprocess.DEVNULL, check=False)
        except subprocess.TimeoutExpired:
            return Result(124, "", "timeout")
        except OSError as e:
            return Result(127, "", type(e).__name__)
        if len(p.stdout) > 65536 or len(p.stderr) > 65536:
            return Result(125, "", "output_too_large")
        return Result(p.returncode, p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace"))

    def popen(self, args: list[str]) -> subprocess.Popen:
        """Start a long-running docker command with piped stdout/stderr (e.g. `start -a`)."""
        return subprocess.Popen([self.binary, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=self.env, close_fds=True)
