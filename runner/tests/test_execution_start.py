"""Docker-start evidence under simulated dispatch faults. No Docker process is used."""
from __future__ import annotations

import io
from datetime import datetime, timezone

import pytest

from logless_runner.docker import Result
from logless_runner.supervisor import Supervisor, docker_start

from .fakes import Behavior, FakeDocker, frame
from .test_supervisor import run_one, settings, spec


class FailedStartProc:
    def __init__(self):
        self.stdout = io.BytesIO(b"")
        self.stderr = io.BytesIO(b"start request failed")
        self.returncode = 125

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        pass


class NeverStartedDocker(FakeDocker):
    def popen(self, args):
        self.calls.append(list(args))
        proc = FailedStartProc()
        self.procs[args[-1]] = proc
        return proc


class WaitFailureDocker(FakeDocker):
    def popen(self, args):
        proc = super().popen(args)
        original = proc.wait
        first = True

        def wait(timeout=None):
            nonlocal first
            if first:
                first = False
                raise RuntimeError("simulated attach wait failure")
            return original(timeout)

        proc.wait = wait
        return proc


@pytest.mark.parametrize("raw,wanted", [
    ("0001-01-01T00:00:00Z", (True, None)),
    ("0001-01-01T00:00:00.000000000Z", (True, None)),
    ("0001-01-01T00:00:00.000000001Z", (False, None)),
    ("2026-09-27T03:04:05.123456789Z", (True, "2026-09-27T03:04:05.123456Z")),
    ("2026-09-27T03:04:05Z", (True, "2026-09-27T03:04:05.000000Z")),
    ("2026-02-30T03:04:05Z", (False, None)),
    ("2026-09-27T03:04:05.1234567890Z", (False, None)),
    ("missing", (False, None)),
])
def test_docker_start_timestamp_contract(raw, wanted):
    assert docker_start(raw) == wanted


def test_created_container_whose_start_failed_has_no_execution_timing(tmp_path):
    fake = NeverStartedDocker()
    _, rec = run_one(tmp_path, fake)
    doc = rec.view()
    assert doc["state"] == "failed" and doc["error"] == "runner_error"
    assert doc["started_at"] is None and doc["elapsed_ms"] is None and doc["runtime"] is None
    assert doc["timed_out"] is False and doc["output"] is None
    assert doc["container_removed"] is True and not fake.containers
    assert rec.spec.files == {} and rec.spec.code == ""


@pytest.mark.parametrize("exit_code", [0, 1])
def test_observed_docker_start_is_used_for_success_and_failure(tmp_path, exit_code):
    class FixedStart(FakeDocker):
        def popen(self, args):
            proc = super().popen(args)
            self.containers[args[-1]]["started_at"] = "2026-09-27T03:04:05.123456789Z"
            return proc

    _, rec = run_one(tmp_path, FixedStart(behavior=Behavior(stdout=frame(b"{}"), exit=exit_code)))
    doc = rec.view()
    assert doc["state"] == ("succeeded" if exit_code == 0 else "failed")
    assert doc["started_at"] == "2026-09-27T03:04:05.123456Z"
    assert doc["elapsed_ms"] is not None and doc["runtime"] == "runsc"
    assert doc["exit_code"] == exit_code and doc["container_removed"] is True


def test_submillisecond_timestamp_precision_does_not_reverse_start_and_finish(tmp_path, monkeypatch):
    class FinishClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 27, 3, 4, 5, 123900, tzinfo=timezone.utc)

    class PreciseStart(FakeDocker):
        def popen(self, args):
            proc = super().popen(args)
            self.containers[args[-1]]["started_at"] = "2026-09-27T03:04:05.123456789Z"
            return proc

    monkeypatch.setattr("logless_runner.supervisor.datetime", FinishClock)
    _, rec = run_one(tmp_path, PreciseStart(behavior=Behavior(stdout=frame(b"{}"))))
    doc = rec.view()
    assert doc["state"] == "succeeded"
    assert datetime.fromisoformat(doc["finished_at"]) >= datetime.fromisoformat(doc["started_at"])


@pytest.mark.parametrize("fault", ["missing", "malformed", "zero_but_running", "inspect_failure"])
def test_unknown_or_contradictory_start_evidence_is_not_reported_as_never_started(tmp_path, fault):
    class BadStartEvidence(FakeDocker):
        def run(self, args, timeout=20.0):
            result = super().run(args, timeout)
            if args[0] != "inspect":
                return result
            if fault == "inspect_failure":
                return Result(1, "", "unavailable")
            parts = result.out.split()
            if fault == "missing":
                parts.pop()
            elif fault == "malformed":
                parts[-1] = "unknown"
            else:
                parts[-1], parts[2] = "0001-01-01T00:00:00Z", "true"
            return Result(0, " ".join(parts), "")

    fake = BadStartEvidence(behavior=Behavior(stdout=frame(b"{}")))
    _, rec = run_one(tmp_path, fake)
    doc = rec.view()
    assert doc["state"] == "failed" and doc["output"] is None
    assert doc["started_at"] is None and doc["runtime"] is None and doc["elapsed_ms"] is not None
    assert doc["container_removed"] is True and not fake.containers


@pytest.mark.parametrize("fault", ["popen", "reader", "wait", "inspect"])
def test_dispatch_exceptions_preserve_uncertainty_and_still_clean_up(tmp_path, monkeypatch, fault):
    class DispatchFailure(WaitFailureDocker if fault == "wait" else FakeDocker):
        def popen(self, args):
            if fault == "popen":
                raise RuntimeError("simulated dispatch failure")
            return super().popen(args)

        def run(self, args, timeout=20.0):
            if fault == "inspect" and args[0] == "inspect":
                raise RuntimeError("simulated inspection failure")
            return super().run(args, timeout)

    if fault == "reader":
        import threading
        from logless_runner.supervisor import _pump
        original = threading.Thread.start

        def start(thread):
            if thread._target is _pump:
                raise RuntimeError("simulated reader failure")
            return original(thread)

        monkeypatch.setattr(threading.Thread, "start", start)
    fake = DispatchFailure(behavior=Behavior(stdout=frame(b"{}"), duration=None if fault in ("wait", "reader") else 0.01))
    sup = Supervisor(settings(tmp_path), docker=fake)
    submitted = spec()
    rec, _ = sup.submit(submitted)
    sup.q.get_nowait()
    with pytest.raises(RuntimeError, match="simulated"):
        sup.execute(rec)
    doc = rec.view()
    assert doc["state"] == "failed" and doc["error"] == "runner_error"
    assert doc["started_at"] is None and doc["elapsed_ms"] is not None and doc["runtime"] is None
    assert doc["output"] is None and doc["container_removed"] is True and not fake.containers
    assert rec.spec.files == {} and rec.spec.code == ""
    for proc in fake.procs.values():
        assert proc.returncode is not None and proc.stdout.closed and proc.stderr.closed
