"""Client for the sandbox runner (docs/CONTRACTS.md §9). The runner lives on a separate VM that
holds no API keys or cloud credentials (only the runner's own auth token, shared with the app VM).

The sandbox VM is the less trusted side, so every runner response is validated against a strict,
bounded schema before anything reads it: enumerated states, error codes and runtimes; bounded
integers; ISO timestamps; the job id and code hash must match what was submitted. Display
metadata that reaches a browser (image name/digest, host label, limits) comes from app-side
configuration, never from runner-supplied strings."""
from __future__ import annotations

import hashlib
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..config import settings

log = logging.getLogger("logless.sandbox")
TERMINAL = {"succeeded", "failed", "timed_out"}

RUNNER_ERRORS = (
    "timeout", "nonzero_exit", "oom_killed", "no_output", "output_too_large", "output_not_regular_file",
    "too_many_output_files", "output_unreadable", "not_utf8", "bad_output_frame", "container_create_failed",
    "image_missing", "image_digest_mismatch", "runtime_unavailable", "runner_error", "cleanup_failed",
)
ISO = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
IMAGE_REF = re.compile(r"^[a-z0-9][a-z0-9._/-]{0,80}:[A-Za-z0-9._-]{1,40}@sha256:[0-9a-f]{64}$")


class SandboxUnavailable(RuntimeError):
    """The runner could not be reached or refused the request (auth, busy, server error)."""

    def __init__(self, code: str):
        super().__init__(f"sandbox unavailable: {code}")
        self.code = code


class SandboxInvalidResponse(SandboxUnavailable):
    """The runner answered, but not with a well-formed response for the job we submitted."""


class _Limits(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    cpus: float = Field(ge=0, le=64)
    memory_mb: int = Field(ge=0, le=65536)
    pids: int = Field(ge=0, le=100000)
    timeout_s: float = Field(ge=0, le=3600)
    network: Literal["none"]
    read_only_root: Literal[True]


class RunnerJob(BaseModel):
    """GET /jobs/{id} as the runner must send it. Anything else is rejected, not coerced."""
    model_config = ConfigDict(extra="forbid", strict=True)
    job_id: str = Field(pattern=UUID)
    kind: Literal["analysis", "aggregate", "containment"]
    state: Literal["queued", "running", "succeeded", "failed", "timed_out"]
    exit_code: int | None = Field(default=None, ge=-512, le=512)
    started_at: str | None = Field(default=None, pattern=ISO)
    finished_at: str | None = Field(default=None, pattern=ISO)
    elapsed_ms: int | None = Field(default=None, ge=0, le=600_000)
    timed_out: bool
    container_removed: bool
    runtime: Literal["runsc", "runc"] | None
    image: str | None = Field(default=None, max_length=200)
    output: str | None = Field(default=None, max_length=1024 * 1024)
    output_bytes: int = Field(ge=0, le=64 * 1024 * 1024)
    stderr_tail: str = Field(default="", max_length=4096)
    error: Literal[RUNNER_ERRORS] | None = None  # type: ignore[valid-type]
    host: str | None = Field(default=None, max_length=255)
    code_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    limits: _Limits


@dataclass
class JobResult:
    raw: dict

    def __getitem__(self, k: str) -> Any:
        return self.raw[k]

    def get(self, k: str, default: Any = None) -> Any:
        return self.raw.get(k, default)

    @property
    def state(self) -> str:
        return self.raw["state"]

    @property
    def output(self) -> str | None:
        return self.raw.get("output")

    @property
    def stderr_tail(self) -> str:
        return self.raw.get("stderr_tail") or ""


def validate_job(data: Any, *, job_id: str, code_sha256: str) -> RunnerJob:
    """Strictly validate a runner job document and bind it to what we submitted."""
    try:
        job = RunnerJob.model_validate(data)
    except ValidationError:
        raise SandboxInvalidResponse("invalid_response") from None
    if job.job_id != job_id or job.code_sha256 != code_sha256:
        raise SandboxInvalidResponse("mismatched_job")
    if job.state in ("succeeded", "timed_out") and None in (job.elapsed_ms, job.started_at, job.finished_at):
        raise SandboxInvalidResponse("incomplete_response")
    if job.state == "succeeded" and (job.output is None or job.exit_code != 0 or not job.container_removed):
        raise SandboxInvalidResponse("inconsistent_response")
    if job.state != "succeeded" and job.output is not None:
        raise SandboxInvalidResponse("inconsistent_response")
    return job


# ---------------------------------------------------------------- trusted display metadata

def display_image(reported: str | None) -> str:
    """The image shown in receipts: the configured name, plus the digest only if the configured
    digest is set and the runner reports exactly that reference."""
    name = os.environ.get("SANDBOX_IMAGE", "logless-analysis:1")
    digest = os.environ.get("SANDBOX_IMAGE_DIGEST", "")
    expected = f"{name}@{digest}" if digest else None
    if expected and reported == expected and IMAGE_REF.match(expected):
        return expected
    if expected and reported != expected:
        log.warning("runner reported an unexpected image reference")
    return name


def host_label() -> str:
    return os.environ.get("SANDBOX_HOST_LABEL", "logless-sandbox")


def receipt(res: JobResult, code_sha256: str, *, timeout_s: float, memory_mb: int = 512) -> dict:
    """The sanitized Receipt of docs/CONTRACTS.md §6. Runner-reported values are used only where
    they are validated measurements (state flags, exit code, timings, sizes); names and limits
    come from the app side."""
    return {
        "job_id": res["job_id"],
        "runtime": res.get("runtime") if res.get("runtime") in ("runsc", "runc") else "runsc",
        "image": display_image(res.get("image")),
        "code_sha256": code_sha256,
        "exit_code": res.get("exit_code"),
        "elapsed_ms": int(res.get("elapsed_ms") or 0),
        "timed_out": bool(res.get("timed_out")),
        "output_bytes": int(res.get("output_bytes") or 0),
        "container_removed": bool(res.get("container_removed")),
        "limits": {"cpus": 1, "memory_mb": int(memory_mb), "pids": 64, "timeout_s": float(timeout_s),
                   "network": "none", "read_only_root": True},
        "started_at": res.get("started_at") or "",
        "finished_at": res.get("finished_at") or "",
        "host": host_label(),
    }


class RunnerClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, transport: httpx.BaseTransport | None = None):
        s = settings()
        self.base = (base_url or s.runner_url).rstrip("/")
        self.token = token if token is not None else s.runner_token
        self._http = httpx.Client(timeout=httpx.Timeout(10.0, connect=2.0), transport=transport)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def _call(self, method: str, path: str, *, json: dict | None = None, timeout: float | None = None) -> httpx.Response:
        try:
            r = self._http.request(method, self.base + path, json=json, headers=self._headers(),
                                   timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT)
        except httpx.HTTPError as e:
            raise SandboxUnavailable(type(e).__name__) from None
        if r.status_code in (401, 403):
            raise SandboxUnavailable("unauthorized")
        if r.status_code in (429, 503):
            raise SandboxUnavailable("busy")
        if r.status_code >= 500:
            raise SandboxUnavailable(f"http_{r.status_code}")
        return r

    def health(self, timeout: float = 1.5) -> dict | None:
        """The runner's /health, or None if it does not answer within `timeout`."""
        try:
            r = self._http.get(self.base + "/health", timeout=timeout)
            data = r.json() if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None
        return {"status": "ok"} if isinstance(data, dict) and data.get("status") == "ok" else {"status": "degraded"}

    def submit(self, *, kind: str, code: str, files: dict[str, str], timeout_s: float, memory_mb: int = 512,
               job_id: str | None = None) -> str:
        job_id = job_id or str(uuid.uuid4())
        body = {"job_id": job_id, "kind": kind, "code": code, "files": files, "timeout_s": timeout_s, "memory_mb": memory_mb}
        for attempt in range(3):  # idempotent on job_id, so a retry after a lost response is safe
            try:
                r = self._call("POST", "/jobs", json=body, timeout=30.0)
                break
            except SandboxUnavailable as e:
                if e.code in ("unauthorized",) or attempt == 2:
                    raise
                time.sleep(0.3 * (attempt + 1))
        if r.status_code != 202:
            raise SandboxUnavailable(f"rejected_{r.status_code}")
        return job_id

    def get(self, job_id: str, code_sha256: str) -> JobResult:
        r = self._call("GET", f"/jobs/{job_id}")
        if r.status_code != 200:
            raise SandboxUnavailable(f"job_{r.status_code}")
        try:
            data = r.json()
        except ValueError:
            raise SandboxInvalidResponse("invalid_response") from None
        return JobResult(validate_job(data, job_id=job_id, code_sha256=code_sha256).model_dump())

    def wait(self, job_id: str, code_sha256: str, *, timeout: float, poll: float = 0.1) -> JobResult:
        deadline = time.monotonic() + timeout
        misses = 0
        while True:
            try:
                res = self.get(job_id, code_sha256)
                misses = 0
            except SandboxInvalidResponse:
                raise
            except SandboxUnavailable:
                misses += 1
                if misses >= 5:
                    raise
                res = None
            if res is not None and res.state in TERMINAL:
                return res
            if time.monotonic() > deadline:
                raise SandboxUnavailable("wait_timeout")
            time.sleep(poll)

    def run(self, *, kind: str, code: str, files: dict[str, str], timeout_s: float, memory_mb: int = 512) -> JobResult:
        """Submit and wait. Allows for queueing plus container start/teardown around the deadline."""
        job_id = self.submit(kind=kind, code=code, files=files, timeout_s=timeout_s, memory_mb=memory_mb)
        return self.wait(job_id, hashlib.sha256(code.encode()).hexdigest(), timeout=timeout_s + 60)
