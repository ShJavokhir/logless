"""In-process fake of the docker CLI used by the supervisor unit tests."""
from __future__ import annotations

import io
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone

from logless_runner.docker import Result


@dataclass
class Behavior:
    stdout: bytes = b""
    stderr: bytes = b""
    exit: int = 0
    duration: float | None = 0.01   # None = never exits on its own (runaway)
    oom: bool = False


class FakeProc:
    def __init__(self, docker: "FakeDocker", name: str, b: Behavior):
        self.docker, self.name, self.b = docker, name, b
        self.done = threading.Event()
        self.stdout = io.BytesIO(b.stdout)
        self.stderr = io.BytesIO(b.stderr)
        self.returncode: int | None = None
        if b.duration is not None:
            threading.Timer(b.duration, self._finish, args=(b.exit,)).start()

    def _finish(self, code: int) -> None:
        if not self.done.is_set():
            self.returncode = code
            self.docker.containers.get(self.name, {})["exit"] = code
            self.done.set()

    def wait(self, timeout: float | None = None) -> int:
        if not self.done.wait(timeout):
            raise subprocess.TimeoutExpired("docker start", timeout)
        return self.returncode  # type: ignore[return-value]

    def kill(self) -> None:
        self._finish(137)


@dataclass
class FakeDocker:
    behavior: Behavior = field(default_factory=Behavior)
    image_id: str = "sha256:" + "ab" * 32
    runtimes: tuple[str, ...] = ("runc", "runsc")
    create_rc: int = 0
    stuck_containers: bool = False   # rm -f "succeeds" but the container stays (verification must fail)
    containers: dict[str, dict] = field(default_factory=dict)
    calls: list[list[str]] = field(default_factory=list)
    procs: dict[str, FakeProc] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def run(self, args: list[str], timeout: float = 20.0) -> Result:
        with self.lock:
            self.calls.append(list(args))
        cmd = args[0]
        if cmd == "version":
            return Result(0, "29.0.0\n", "")
        if cmd == "info":
            import json
            return Result(0, json.dumps({r: {} for r in self.runtimes}), "")
        if cmd == "image":
            return Result(0, self.image_id + "\n", "") if self.image_id else Result(1, "", "No such image")
        if cmd == "create":
            if self.create_rc:
                return Result(self.create_rc, "", "create failed")
            name = args[args.index("--name") + 1]
            label = args[args.index("--label") + 1]
            self.containers[name] = {"label": label, "args": list(args), "exit": None, "started_at": "0001-01-01T00:00:00Z"}
            return Result(0, "cid-" + name + "\n", "")
        if cmd == "kill":
            name = args[-1]
            if name in self.procs:
                self.procs[name].kill()
            return Result(0, name, "")
        if cmd == "inspect":
            name = args[-1]
            c = self.containers.get(name)
            if c is None:
                return Result(1, "", "no such container")
            runtime = next((a.split("=", 1)[1] for a in c["args"] if a.startswith("--runtime=")), "runc")
            code = c["exit"] if c["exit"] is not None else 0
            started_at = c.get("started_at", "0001-01-01T00:00:00Z")
            running = c["exit"] is None and not started_at.startswith("0001-")
            return Result(0, f"{code} {'true' if self.behavior.oom else 'false'} {'true' if running else 'false'} "
                            f"{runtime} {c['args'][-3]} {started_at}\n", "")
        if cmd == "rm":
            if not self.stuck_containers:
                for name in args[2:]:
                    self.containers.pop(name, None)
                    for n in [n for n in self.containers if "cid-" + n == name]:
                        self.containers.pop(n, None)
            return Result(0, "", "")
        if cmd == "ps":
            flt = args[args.index("--filter") + 1]
            want = flt.split("=", 1)[1]
            ids = [n for n, c in self.containers.items() if c["label"] == want or (want == "logless.job" and c["label"].startswith("logless.job="))]
            if "--format" in args:  # '{{.ID}} {{.Label "logless.job"}}'
                return Result(0, "\n".join(f"{n} {self.containers[n]['label'].split('=', 1)[1]}" for n in ids), "")
            return Result(0, "\n".join(ids), "")
        return Result(1, "", "unknown")

    def popen(self, args: list[str]) -> FakeProc:
        with self.lock:
            self.calls.append(list(args))
        name = args[-1]
        self.containers[name]["started_at"] = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
        p = FakeProc(self, name, self.behavior)
        self.procs[name] = p
        return p


def frame(data: bytes, status: str = "ok", code: int = 0) -> bytes:
    return f"LOGLESS/1 {status} {code} {len(data)}\n".encode() + data
