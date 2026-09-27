"""Job supervisor: one fresh container per job, deadline enforced from outside, always removed.

Lifecycle of a job:
  1. write /in (read-only bind mount): the job's input files, program.py, and the bootstrap as main.py
  2. `docker create` with the fixed flags from docs/CONTRACTS.md §9 (label logless.job=<id>)
  3. `docker start -a` — the monotonic clock starts here; stdout/stderr go through bounded pipes
  4. at the deadline: `docker kill` (SIGKILL); elapsed is measured when the attach stream ends
  5. `docker inspect` (exit code, OOM, runtime actually used), `docker rm -f`, then verify with
     `docker ps -a --filter label=logless.job=<id>` that nothing is left → container_removed
  6. parse the bootstrap's frame from stdout (≤ 1 MiB result), delete the job dir, keep the
     result in memory for a TTL
"""
from __future__ import annotations

import hashlib
import json
import logging
import queue
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path
from typing import Any

from . import config
from .config import Settings
from .docker import Docker

log = logging.getLogger("logless.runner")

TERMINAL = {"succeeded", "failed", "timed_out"}
RECONCILE_S = 5.0          # retry unverified removals this often
ORPHAN_SWEEP_EVERY = 12    # … and sweep for labelled orphans every 12 reconcile ticks (~1 min)
STOP_GRACE_S = 15.0       # leave headroom inside systemd's 20-second stop budget
IMAGE_ID_RE = re.compile(r"sha256:[0-9a-f]{64}")
DOCKER_TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z")
ALLOWED_INPUTS = {"assignments.csv", "clusters.json", "contract.json"}
MAX_RECORDS = 2000
QUEUE_MAX = 16
FRAME_RE = re.compile(rb"^LOGLESS/1 (ok|missing|not_regular|too_large|too_many_files|unreadable|skipped) (-?\d{1,4}) (\d{1,8})$")
FRAME_ERRORS = {
    "missing": "no_output",
    "not_regular": "output_not_regular_file",
    "too_large": "output_too_large",
    "unreadable": "output_unreadable",
    "too_many_files": "too_many_output_files",
    "skipped": "nonzero_exit",
}


def utcnow() -> str:
    # Match normalized Docker start precision so a sub-millisecond execution
    # cannot appear to finish before it started after timestamp truncation.
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def docker_start(value: str) -> tuple[bool, str | None]:
    """(known, timestamp): Docker's zero time confirms no start; invalid data is unknown.

    Docker uses RFC3339Nano. Normalize observed starts to microseconds for the
    existing backend/public timestamp contract, never substitute dispatch time.
    """
    if not DOCKER_TIME_RE.fullmatch(value):
        return False, None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False, None
    if re.fullmatch(r"0001-01-01T00:00:00(?:\.0{1,9})?Z", value):
        return True, None
    if parsed == datetime.min.replace(tzinfo=timezone.utc):
        return False, None  # nonzero nanoseconds below Python's precision are not the zero sentinel
    return True, parsed.isoformat(timespec="microseconds").replace("+00:00", "Z")


def bootstrap_source() -> str:
    return resources.files("logless_runner").joinpath("bootstrap.py").read_text()


class QueueFull(RuntimeError):
    pass


class JobConflict(RuntimeError):
    pass


class Quarantined(RuntimeError):
    """A container could not be verified as removed; admission is paused until reconciliation."""


class Stopping(RuntimeError):
    """Admission is closed because the supervisor is stopping."""


@dataclass(frozen=True)
class JobSpec:
    job_id: str
    kind: str
    code: str
    files: dict[str, str]
    timeout_s: float
    memory_mb: int

    @property
    def code_sha256(self) -> str:
        return hashlib.sha256(self.code.encode()).hexdigest()

    def fingerprint(self) -> str:
        h = hashlib.sha256()
        h.update(json.dumps([self.kind, self.code, sorted(self.files.items()), self.timeout_s, self.memory_mb]).encode())
        return h.hexdigest()


@dataclass
class JobRecord:
    spec: JobSpec
    fingerprint: str
    host: str
    state: str = "queued"
    exit_code: int | None = None
    started_at: str | None = None
    finished_at: str | None = None
    elapsed_ms: int | None = None
    timed_out: bool = False
    container_removed: bool = False
    runtime: str | None = None
    image: str | None = None
    output: str | None = None
    output_bytes: int = 0
    stderr_tail: str = ""
    error: str | None = None
    done_mono: float | None = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    code_sha256: str = field(init=False)

    def __post_init__(self) -> None:
        self.code_sha256 = self.spec.code_sha256

    def release_inputs(self) -> None:
        """The TTL retains results/identity, not another copy of the private input dataset."""
        with self.lock:
            self.spec = replace(self.spec, code="", files={})

    def view(self) -> dict[str, Any]:
        with self.lock:
            return self._view()

    def _view(self) -> dict[str, Any]:
        s = self.spec
        return {
            "job_id": s.job_id, "kind": s.kind, "state": self.state, "exit_code": self.exit_code,
            "started_at": self.started_at, "finished_at": self.finished_at, "elapsed_ms": self.elapsed_ms,
            "timed_out": self.timed_out, "container_removed": self.container_removed,
            "runtime": self.runtime, "image": self.image, "output": self.output, "output_bytes": self.output_bytes,
            "stderr_tail": self.stderr_tail, "error": self.error, "host": self.host,
            "code_sha256": self.code_sha256,
            "limits": {"cpus": config.CPUS, "memory_mb": s.memory_mb, "pids": config.PIDS, "timeout_s": s.timeout_s,
                       "network": "none", "read_only_root": True},
        }


class _Sink:
    """Bounded capture of one pipe: keeps the head (for the result frame) or the tail (stderr)."""

    def __init__(self, cap: int, keep: str):
        self.cap, self.keep = cap, keep
        self.buf = bytearray()
        self.total = 0

    def feed(self, chunk: bytes) -> None:
        self.total += len(chunk)
        if self.keep == "head":
            room = self.cap - len(self.buf)
            if room > 0:
                self.buf += chunk[:room]
        else:
            self.buf += chunk
            if len(self.buf) > self.cap:
                del self.buf[: len(self.buf) - self.cap]


def _pump(stream, sink: _Sink) -> None:
    try:
        while True:
            chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
            if not chunk:
                break
            sink.feed(chunk)
    except (OSError, ValueError):
        pass


def parse_frame(buf: bytes, total: int) -> tuple[str, str | None, int]:
    """(status, output text or None, output_bytes) from the bootstrap's stdout frame."""
    if total > len(buf):
        return "too_large", None, total
    nl = buf.find(b"\n")
    if nl < 0:
        return "bad_frame", None, 0
    m = FRAME_RE.match(bytes(buf[:nl]))
    if not m:
        return "bad_frame", None, 0
    status, n = m.group(1).decode(), int(m.group(3))
    data = bytes(buf[nl + 1:])
    if len(data) != n:
        return "bad_frame", None, len(data)
    if status != "ok":
        return status, None, n
    if n > config.MAX_OUTPUT_BYTES:
        return "too_large", None, n
    try:
        return "ok", data.decode("utf-8"), n
    except UnicodeDecodeError:
        return "not_utf8", None, n


class Supervisor:
    def __init__(self, settings: Settings, docker: Docker | None = None):
        self.s = settings
        self.docker = docker or Docker(settings.docker_bin)
        self.records: dict[str, JobRecord] = {}
        self.lock = threading.Lock()
        self.q: queue.Queue[JobRecord] = queue.Queue(maxsize=QUEUE_MAX)
        self.hostname = socket.gethostname()
        self.image_id: str | None = None
        self.image_error: str | None = None
        self.runtime_ok = False
        self.docker_version: str | None = None
        self._health_at = 0.0
        self._workers: list[threading.Thread] = []
        self._stop = threading.Event()
        self._lifecycle_lock = threading.Lock()
        self._health_lock = threading.RLock()
        self._cleanup_lock = threading.Lock()
        self._started = False
        # job_id -> container name whose removal could not be verified. While non-empty, no new job
        # is admitted or started; the reconcile loop retries removal until docker confirms it.
        self.quarantine: dict[str, str] = {}
        self.active: set[str] = set()   # job ids whose containers may legitimately exist right now
        self.orphan_scan_ok = True

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        with self._lifecycle_lock:
            if self._started:
                return
            if any(t.is_alive() for t in self._workers):
                raise RuntimeError("previous supervisor workers are still stopping")
            self._stop.clear()
            self._workers = []
            self.s.work_dir.mkdir(parents=True, exist_ok=True)
            self.reap_orphans()
            for p in self.s.work_dir.iterdir():
                shutil.rmtree(p, ignore_errors=True)
            self.refresh_health(force=True)
            for i in range(self.s.concurrency):
                t = threading.Thread(target=self._work, name=f"runner-worker-{i}", daemon=True)
                t.start()
                self._workers.append(t)
            t = threading.Thread(target=self._reconcile_loop, name="runner-reconcile", daemon=True)
            t.start()
            self._workers.append(t)
            self._started = True

    def stop(self, grace_s: float = STOP_GRACE_S) -> None:
        """Close admission, cancel queued work, and allow active cancellation/cleanup to finish.

        A stuck Docker daemon can outlive this bounded grace period. Such workers remain marked
        stopping, cannot be restarted in this process, and startup orphan reconciliation is still
        required after a process/host crash.
        """
        with self._lifecycle_lock:
            with self.lock:
                self._stop.set()
            while True:
                try:
                    rec = self.q.get_nowait()
                except queue.Empty:
                    break
                self._cancel_queued(rec)
                self.q.task_done()
            deadline = time.monotonic() + max(0.0, grace_s)
            for t in self._workers:
                t.join(timeout=max(0.0, deadline - time.monotonic()))
            self._started = False
            if any(t.is_alive() for t in self._workers):
                log.error("supervisor stop grace expired; startup orphan reconciliation remains required")

    @staticmethod
    def _cancel_queued(rec: JobRecord) -> None:
        with rec.lock:
            rec.state, rec.error, rec.output = "failed", "runner_error", None
            rec.container_removed = True  # no create was attempted for queued work
            rec.finished_at = utcnow()
            rec.done_mono = time.monotonic()
        rec.release_inputs()

    def reap_orphans(self) -> int:
        """Remove every labelled job container that does not belong to a running job."""
        with self._cleanup_lock:
            return self._reap_orphans()

    def _reap_orphans(self) -> int:
        self.orphan_scan_ok = False  # inventory success alone does not establish removal
        r = self.docker.run(["ps", "-a", "--filter", "label=logless.job", "--format", '{{.ID}} {{.Label "logless.job"}}'], timeout=15)
        if r.rc != 0:
            return 0
        inventory_ok = True
        with self.lock:
            active = set(self.active)
        removed = 0
        for line in r.out.splitlines():
            parts = line.split()
            if parts and (len(parts) < 2 or parts[1] not in active):
                name = parts[0]
                # Every runner-created container has a nonempty UUID label. A malformed label
                # cannot be safely verified with the per-job filter; keep admission closed.
                if len(parts) < 2:
                    inventory_ok = False
                    continue
                job_id = parts[1]
                if self._remove(job_id, name, tries=1):
                    removed += 1
                else:
                    with self.lock:
                        self.quarantine[job_id] = name
        if removed:
            log.warning("reaped %d orphaned job containers", removed)
        self.orphan_scan_ok = inventory_ok
        return removed

    def reconcile(self) -> int:
        """Retry removal of quarantined containers; lift the quarantine once docker confirms."""
        with self._cleanup_lock:
            return self._reconcile()

    def _reconcile(self) -> int:
        with self.lock:
            pending = dict(self.quarantine)
        for job_id, name in pending.items():
            if self._remove(job_id, name, tries=1):
                with self.lock:
                    self.quarantine.pop(job_id, None)
                log.warning("container for job %s is now verified removed; quarantine entry cleared", job_id)
        with self.lock:
            return len(self.quarantine)

    def _reconcile_loop(self) -> None:
        tick = 0
        while not self._stop.wait(RECONCILE_S):
            tick += 1
            try:
                if self.quarantine:
                    self.reconcile()
                if not self.orphan_scan_ok or tick % ORPHAN_SWEEP_EVERY == 0:
                    self.reap_orphans()
            except Exception:  # noqa: BLE001 — keep reconciling
                log.exception("reconcile tick failed")

    # ------------------------------------------------------------------ health

    def refresh_health(self, force: bool = False) -> None:
        with self._health_lock:
            self._refresh_health(force)

    def _refresh_health(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._health_at < 10:
            return
        v = self.docker.run(["version", "--format", "{{.Server.Version}}"], timeout=5)
        self.docker_version = v.out.strip() if v.rc == 0 and v.out.strip() else None
        if self.docker_version is None:
            self.runtime_ok, self.image_id, self.image_error = False, None, "docker_unreachable"
            self._health_at = time.monotonic()
            return
        info = self.docker.run(["info", "--format", "{{json .Runtimes}}"], timeout=5)
        try:
            runtimes = json.loads(info.out or "{}")
            self.runtime_ok = info.rc == 0 and isinstance(runtimes, dict) and self.s.runtime in runtimes
        except ValueError:
            self.runtime_ok = False
        img = self.docker.run(["image", "inspect", "--format", "{{.Id}}", self.s.image], timeout=5)
        image_id = img.out.strip() if img.rc == 0 else ""
        if not IMAGE_ID_RE.fullmatch(image_id):
            self.image_id, self.image_error = None, "image_missing"
        elif self.s.image_digest and image_id != self.s.image_digest:
            self.image_id, self.image_error = None, "image_digest_mismatch"
        else:
            self.image_id, self.image_error = image_id, None
        self._health_at = time.monotonic()

    def health(self) -> dict[str, Any]:
        with self._health_lock:
            return self._health()

    def _health(self) -> dict[str, Any]:
        self.refresh_health()
        ok = self.docker_version is not None and self.runtime_ok and self.image_id is not None \
            and not self.quarantine and self.orphan_scan_ok and not self._stop.is_set()
        return {
            "status": "ok" if ok else "degraded",
            "quarantined": len(self.quarantine),
            "runtime": self.s.runtime if self.runtime_ok else f"{self.s.runtime} (unavailable)",
            "image": self.image_ref() if self.image_id else f"{self.s.image} ({self.image_error})",
            "docker": self.docker_version or "unreachable",
            "queued": self.q.qsize(),
        }

    def image_ref(self) -> str:
        return f"{self.s.image}@{self.image_id}" if self.image_id else self.s.image

    # ------------------------------------------------------------------ jobs

    def submit(self, spec: JobSpec) -> tuple[JobRecord, bool]:
        """Queue a job. Idempotent on job_id: the same id returns the existing record."""
        fp = spec.fingerprint()
        with self.lock:
            self._purge()
            rec = self.records.get(spec.job_id)
            if rec is not None:
                if rec.fingerprint != fp:
                    raise JobConflict(spec.job_id)
                return rec, False
            if self._stop.is_set():
                raise Stopping("runner is stopping")
            if self.quarantine or not self.orphan_scan_ok:
                raise Quarantined("a previous container could not be verified as removed")
            if len(self.records) >= MAX_RECORDS:
                raise QueueFull("too many stored jobs")
            rec = JobRecord(spec=spec, fingerprint=fp, host=self.hostname)
            try:
                self.q.put_nowait(rec)
            except queue.Full as e:
                raise QueueFull("queue full") from e
            self.records[spec.job_id] = rec
            return rec, True

    def get(self, job_id: str) -> JobRecord | None:
        with self.lock:
            self._purge()
            return self.records.get(job_id)

    def _purge(self) -> None:
        now = time.monotonic()
        for jid in [j for j, r in self.records.items() if r.done_mono and now - r.done_mono > self.s.result_ttl_s]:
            del self.records[jid]

    def _work(self) -> None:
        while not self._stop.is_set():
            if self.quarantine or not self.orphan_scan_ok:  # hold capacity until removal is verified
                self._stop.wait(0.5)
                continue
            try:
                rec = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                while (self.quarantine or not self.orphan_scan_ok) and not self._stop.is_set():
                    self._stop.wait(0.1)
                if self._stop.is_set():
                    self._cancel_queued(rec)
                else:
                    self.execute(rec)
            except Exception:  # never leave a job non-terminal
                log.exception("job %s crashed in the supervisor", rec.spec.job_id)
                with rec.lock:
                    if rec.state not in TERMINAL:
                        rec.state, rec.error = "failed", "runner_error"
            finally:
                rec.done_mono = time.monotonic()
                rec.release_inputs()
                self.q.task_done()

    def container_args(self, spec: JobSpec, name: str, in_dir: Path, image: str) -> list[str]:
        m = int(spec.memory_mb)
        return [
            "create", "--name", name, "--label", f"logless.job={spec.job_id}", "--label", f"logless.kind={spec.kind}",
            f"--runtime={self.s.runtime}", "--network=none", "--read-only",
            "--tmpfs", f"/tmp:{self.s.tmp_tmpfs}", "--tmpfs", f"/out:{self.s.out_tmpfs}",
            "--cap-drop=ALL", "--security-opt=no-new-privileges", f"--pids-limit={config.PIDS}",
            f"--memory={m}m", f"--memory-swap={m}m", f"--cpus={config.CPUS}",
            "--user", f"{config.SANDBOX_UID}:{config.SANDBOX_UID}",
            "--ulimit", "core=0", "--ulimit", "nofile=256", "--log-driver=none",
            "--mount", f"type=bind,source={in_dir},target=/in,readonly",
            image, "python", "/in/main.py",
        ]

    def execute(self, rec: JobRecord) -> None:
        try:
            self._execute(rec)
        finally:
            if rec.state in TERMINAL:
                rec.release_inputs()

    def _execute(self, rec: JobRecord) -> None:
        spec = rec.spec
        if self._stop.is_set():
            self._cancel_queued(rec)
            return
        with rec.lock:
            rec.state = "running"
            rec.runtime = self.s.runtime
        with self._health_lock:
            self.refresh_health()
            image_id, runtime_ok, image_error = self.image_id, self.runtime_ok, self.image_error
        with rec.lock:
            rec.image = f"{self.s.image}@{image_id}" if image_id else self.s.image
        if image_id is None or not runtime_ok:
            with rec.lock:
                rec.container_removed = True  # nothing was created
                rec.state = "failed"
                rec.error = "runner_error" if image_error == "docker_unreachable" else (image_error or "runtime_unavailable")
            return

        job_dir = self.s.work_dir / f"{spec.job_id}-{secrets.token_hex(4)}"
        name = f"logless-job-{spec.job_id[:8]}-{secrets.token_hex(4)}"
        outcome: dict[str, Any] = {"state": "failed", "error": "runner_error"}
        with self.lock:
            self.active.add(spec.job_id)
        try:
            in_dir = job_dir / "in"
            in_dir.mkdir(parents=True, mode=0o755)
            job_dir.chmod(0o755)
            in_dir.chmod(0o755)
            for fname, content in spec.files.items():
                (in_dir / fname).write_text(content, encoding="utf-8")
            (in_dir / "program.py").write_text(spec.code, encoding="utf-8")
            (in_dir / "main.py").write_text(bootstrap_source(), encoding="utf-8")
            for p in in_dir.iterdir():
                p.chmod(0o644)
            outcome = self._run_container(spec, name, in_dir, image_id, outcome)
        finally:
            # The job only becomes terminal after its container is verified gone. If that cannot be
            # verified, the job fails (never "succeeded"), its output is dropped, and admission is
            # quarantined until the reconcile loop confirms the container is gone.
            removed = self._remove(spec.job_id, name)
            shutil.rmtree(job_dir, ignore_errors=True)
            if job_dir.exists():
                log.warning("job dir for %s could not be deleted", spec.job_id)
            if not removed:
                outcome.update(state="failed", error="cleanup_failed", output=None)
            with self.lock:
                self.active.discard(spec.job_id)
                if not removed:
                    self.quarantine[spec.job_id] = name
            with rec.lock:
                state = outcome.pop("state")
                for k, v in outcome.items():
                    setattr(rec, k, v)
                rec.container_removed = removed
                rec.state = state

    def _run_container(self, spec: JobSpec, name: str, in_dir: Path, image_id: str,
                       uncertain: dict[str, Any]) -> dict[str, Any]:
        if self._stop.is_set():
            return {"state": "failed", "error": "runner_error"}
        created = self.docker.run(self.container_args(spec, name, in_dir, image_id), timeout=60)
        if created.rc != 0:
            log.warning("docker create failed for %s rc=%s", spec.job_id, created.rc)
            return {"state": "failed", "error": "container_create_failed"}
        if self._stop.is_set():
            return {"state": "failed", "error": "runner_error"}

        out_sink = _Sink(config.MAX_OUTPUT_BYTES + 256, "head")
        err_sink = _Sink(config.MAX_STREAM_BYTES, "tail")
        t0 = time.monotonic()
        # A dispatch may have reached Docker even if the CLI/reader/inspection
        # adapter raises. Keep partial timing in the outer cleanup outcome so
        # the backend rejects uncertainty rather than treating it as no start.
        uncertain.update(started_at=None, elapsed_ms=0, runtime=None)
        proc = None
        readers: list[threading.Thread] = []
        timed_out, cancelled = False, False
        try:
            proc = self.docker.popen(["start", "-a", name])
            for stream, sink in ((proc.stdout, out_sink), (proc.stderr, err_sink)):
                reader = threading.Thread(target=_pump, args=(stream, sink), daemon=True)
                reader.start()
                readers.append(reader)
            while True:
                if self._stop.is_set():
                    cancelled = True
                    break
                remaining = spec.timeout_s - (time.monotonic() - t0)
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    proc.wait(timeout=min(0.1, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
            if timed_out or cancelled:
                self.docker.run(["kill", "--signal", "KILL", name], timeout=5)
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
        finally:
            uncertain.update(elapsed_ms=int(round((time.monotonic() - t0) * 1000)), finished_at=utcnow())
            # Reap the attach CLI even if a wait/inspect adapter raised. Never close a pipe while
            # a reader owns its blocking read lock; that can make shutdown hang without a bound.
            if proc is not None and proc.returncode is None:
                proc.kill()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    log.error("docker attach process for %s did not exit after kill", spec.job_id)
            if proc is not None:
                for i, stream in enumerate((proc.stdout, proc.stderr)):
                    reader = readers[i] if i < len(readers) else None
                    if reader is not None:
                        reader.join(timeout=2)
                    if reader is None or not reader.is_alive():
                        stream.close()
        elapsed_ms = int(round((time.monotonic() - t0) * 1000))
        finished_at = utcnow()

        exit_code, oom, runtime, running, actual_image = None, False, None, True, None
        start_known, started_at = False, None
        insp = self.docker.run(["inspect", "--format", "{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.Running}} "
                                "{{.HostConfig.Runtime}} {{.Image}} {{.State.StartedAt}}", name], timeout=10)
        if insp.rc == 0:
            parts = insp.out.split()
            if len(parts) == 6 and parts[1] in ("true", "false") and parts[2] in ("true", "false"):
                try:
                    exit_code = int(parts[0])
                except ValueError:
                    exit_code = None
                oom = parts[1] == "true"
                running, runtime, actual_image = parts[2] == "true", parts[3], parts[4]
                start_known, started_at = docker_start(parts[5])

        if started_at is None:
            # A zero StartedAt with a running container is contradictory, not
            # evidence that nothing ran. Unknown evidence deliberately carries
            # elapsed_ms but no runtime: validate_job/receipt fail closed.
            confirmed_unstarted = start_known and not running
            return {"state": "failed", "error": "runner_error", "output": None, "output_bytes": 0,
                    "started_at": None, "finished_at": None if confirmed_unstarted else finished_at,
                    "elapsed_ms": None if confirmed_unstarted else elapsed_ms, "runtime": None,
                    "timed_out": False, "exit_code": None}

        status, output, nbytes = parse_frame(bytes(out_sink.buf), out_sink.total)
        if cancelled:
            state, error, output = "failed", "runner_error", None
        elif timed_out:
            state, error, output = "timed_out", "timeout", None
        elif exit_code is None:
            state, error, output = "failed", "runner_error", None
        elif oom:
            state, error, output = "failed", "oom_killed", None
        elif exit_code != 0:
            state, error, output = "failed", "nonzero_exit", None
        elif running or runtime != self.s.runtime or actual_image != image_id or proc.returncode != 0 \
                or any(t.is_alive() for t in readers):
            state, error, output = "failed", "runner_error", None
        elif status != "ok":
            state, error, output = "failed", FRAME_ERRORS.get(status, "bad_output_frame" if status == "bad_frame" else status), None
        else:
            state, error = "succeeded", None

        tail = bytes(err_sink.buf[-config.STDERR_TAIL_BYTES:]).decode("utf-8", errors="replace")
        return {
            "started_at": started_at, "finished_at": finished_at, "elapsed_ms": elapsed_ms,
            "timed_out": timed_out, "exit_code": exit_code, "runtime": runtime,
            "output": output, "output_bytes": nbytes if status in ("ok", "too_large", "not_utf8") else 0,
            "stderr_tail": tail, "state": state, "error": error,
        }

    def _remove(self, job_id: str, name: str, tries: int = 3) -> bool:
        label = f"label=logless.job={job_id}"
        for _ in range(tries):
            self.docker.run(["rm", "-f", name], timeout=20)
            left = self.docker.run(["ps", "-a", "-q", "--filter", label], timeout=10)
            if left.rc == 0 and not left.out.strip():
                return True
            ids = left.out.split() if left.rc == 0 else []
            if ids:
                self.docker.run(["rm", "-f", *ids], timeout=20)
        log.error("container for job %s could not be verified as removed", job_id)
        return False
