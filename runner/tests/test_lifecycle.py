"""Event-controlled lifecycle faults. No Docker daemon or container program is executed."""
from __future__ import annotations

import threading
import time
from dataclasses import replace

import pytest

from logless_runner.docker import Result
from logless_runner.supervisor import JobConflict, QueueFull, Supervisor

from .fakes import Behavior, FakeDocker, frame
from .test_supervisor import run_one, settings, spec


def test_stop_finishes_queued_jobs_and_closes_admission(tmp_path):
    sup = Supervisor(settings(tmp_path), docker=FakeDocker())
    rec, _ = sup.submit(spec())
    sup.stop()
    assert rec.view()["state"] == "failed"
    assert rec.view()["container_removed"] is True
    assert rec.view()["output"] is None and rec.done_mono is not None
    assert sup.q.unfinished_tasks == 0
    assert rec.spec.files == {} and rec.spec.code == ""
    assert sup.health()["status"] == "degraded"
    with pytest.raises(RuntimeError, match="stopping"):
        sup.submit(spec())


def test_start_is_idempotent_and_does_not_remove_current_input_directory(tmp_path):
    sup = Supervisor(settings(tmp_path), docker=FakeDocker())
    sup.start()
    try:
        workers = tuple(sup._workers)
        active_input = sup.s.work_dir / "active-job" / "in"
        active_input.mkdir(parents=True)
        sup.start()
        assert tuple(sup._workers) == workers
        assert active_input.exists()
    finally:
        sup.stop()


def test_queue_overflow_does_not_create_an_unserviceable_record(tmp_path):
    sup = Supervisor(settings(tmp_path), docker=FakeDocker())
    for _ in range(sup.q.maxsize):
        sup.submit(spec())
    overflow = spec()
    with pytest.raises(QueueFull):
        sup.submit(overflow)
    assert sup.get(overflow.job_id) is None
    assert len(sup.records) == sup.q.maxsize
    sup.stop()


def test_orphan_removal_in_progress_cannot_report_healthy(tmp_path):
    entered, release = threading.Event(), threading.Event()

    class BlockingRemoval(FakeDocker):
        def run(self, args, timeout=20.0):
            if args[0] == "rm":
                entered.set()
                assert release.wait(2)
            return super().run(args, timeout)

    fake = BlockingRemoval()
    fake.containers["old"] = {"label": "logless.job=old", "args": [], "exit": None}
    sup = Supervisor(settings(tmp_path), docker=fake)
    worker = threading.Thread(target=sup.reap_orphans)
    worker.start()
    try:
        assert entered.wait(1)
        assert sup.health()["status"] == "degraded"
    finally:
        release.set()
        worker.join(2)


@pytest.mark.parametrize("runtime_doc,rc,image", [
    ("null", 0, "sha256:" + "ab" * 32),
    ('["runsc"]', 0, "sha256:" + "ab" * 32),
    ('{"runsc": {}}', 1, "sha256:" + "ab" * 32),
    ('{"runsc": {}}', 0, "sha256:not-an-image-id"),
])
def test_health_rejects_malformed_or_failed_docker_attestation(tmp_path, runtime_doc, rc, image):
    class BadInfo(FakeDocker):
        def run(self, args, timeout=20.0):
            if args[0] == "info":
                return Result(rc, runtime_doc, "")
            return super().run(args, timeout)

    sup = Supervisor(settings(tmp_path), docker=BadInfo(image_id=image))
    assert sup.health()["status"] == "degraded"


def test_concurrent_health_waits_for_current_refresh(tmp_path):
    entered, release, second_done = threading.Event(), threading.Event(), threading.Event()

    class BlockingInfo(FakeDocker):
        hold = False

        def run(self, args, timeout=20.0):
            if self.hold and args[0] == "info":
                entered.set()
                assert release.wait(2)
                return Result(0, "{}", "")
            return super().run(args, timeout)

    fake = BlockingInfo()
    sup = Supervisor(settings(tmp_path), docker=fake)
    assert sup.health()["status"] == "ok"
    fake.hold, sup._health_at = True, 0
    refresh = threading.Thread(target=sup.refresh_health)
    refresh.start()
    assert entered.wait(1)
    results = []

    def get_health():
        results.append(sup.health())
        second_done.set()

    observer = threading.Thread(target=get_health)
    observer.start()
    try:
        assert not second_done.wait(0.05), "health exposed the previous success during a pending refresh"
    finally:
        release.set()
        refresh.join(2)
        observer.join(2)
    assert results[0]["status"] == "degraded"


def test_create_timeout_after_daemon_created_container_still_cleans_up(tmp_path):
    class CreateTimeout(FakeDocker):
        def run(self, args, timeout=20.0):
            result = super().run(args, timeout)
            return Result(124, "", "timeout") if args[0] == "create" else result

    fake = CreateTimeout()
    _, rec = run_one(tmp_path, fake)
    assert rec.view()["state"] == "failed" and rec.view()["error"] == "container_create_failed"
    assert rec.view()["container_removed"] is True and not fake.containers


def test_finished_attach_streams_are_closed(tmp_path):
    fake = FakeDocker(behavior=Behavior(stdout=frame(b"{}")))
    _, rec = run_one(tmp_path, fake)
    assert rec.view()["state"] == "succeeded"
    proc = next(iter(fake.procs.values()))
    assert proc.stdout.closed and proc.stderr.closed


def test_stop_cancels_active_job_and_verifies_removal_before_return(tmp_path):
    attached = threading.Event()

    class Attached(FakeDocker):
        def popen(self, args):
            proc = super().popen(args)
            attached.set()
            return proc

    fake = Attached(behavior=Behavior(duration=None))
    sup = Supervisor(settings(tmp_path), docker=fake)
    sup.start()
    rec, _ = sup.submit(spec(timeout_s=10))
    assert attached.wait(1)
    started = time.monotonic()
    sup.stop()
    assert time.monotonic() - started < 1.0
    assert rec.view()["state"] == "failed" and rec.view()["error"] == "runner_error"
    assert rec.view()["timed_out"] is False and rec.view()["container_removed"] is True
    assert not fake.containers and not any(t.is_alive() for t in sup._workers)


def test_restart_refused_until_previous_worker_finishes_create_cleanup(tmp_path):
    creating, release = threading.Event(), threading.Event()

    class BlockingCreate(FakeDocker):
        def run(self, args, timeout=20.0):
            if args[0] == "create":
                creating.set()
                assert release.wait(2)
            return super().run(args, timeout)

    fake = BlockingCreate()
    sup = Supervisor(settings(tmp_path), docker=fake)
    sup.start()
    rec, _ = sup.submit(spec())
    assert creating.wait(1)
    try:
        sup.stop(grace_s=0.01)
        with pytest.raises(RuntimeError, match="still stopping"):
            sup.start()
    finally:
        release.set()
        sup.stop()
    assert rec.view()["state"] == "failed" and rec.view()["container_removed"] is True
    assert not fake.containers and not any(c[0] == "start" for c in fake.calls)
    sup.start()  # the same instance may restart only after old workers exited
    try:
        fake.behavior = Behavior(stdout=frame(b"{}"))
        fresh, _ = sup.submit(spec())
        deadline = time.monotonic() + 1
        while fresh.view()["state"] not in ("succeeded", "failed") and time.monotonic() < deadline:
            time.sleep(0.01)
        assert fresh.view()["state"] == "succeeded"
    finally:
        sup.stop()


@pytest.mark.parametrize("fault", ["running", "runtime", "image", "inspect", "attach_exit"])
def test_success_requires_actual_exit_runtime_image_and_attach_success(tmp_path, fault):
    class BadAttestation(FakeDocker):
        def run(self, args, timeout=20.0):
            result = super().run(args, timeout)
            if args[0] != "inspect":
                return result
            if fault == "inspect":
                return Result(1, "", "inspection failed")
            parts = result.out.split()
            if fault == "running":
                parts[2] = "true"
            elif fault == "runtime":
                parts[3] = "runc"
            elif fault == "image":
                parts[4] = "sha256:" + "cd" * 32
            elif fault == "attach_exit":
                # Docker still reports a zero container exit, but the attachment failed.
                next(iter(self.procs.values())).returncode = 1
            return Result(0, " ".join(parts), "")

    fake = BadAttestation(behavior=Behavior(stdout=frame(b"{}")))
    _, rec = run_one(tmp_path, fake)
    assert rec.view()["state"] == "failed" and rec.view()["error"] == "runner_error"
    assert rec.view()["output"] is None and rec.view()["container_removed"] is True


def test_unreachable_docker_returns_a_defined_protocol_error(tmp_path):
    class Unreachable(FakeDocker):
        def run(self, args, timeout=20.0):
            return Result(127, "", "unreachable") if args[0] == "version" else super().run(args, timeout)

    _, rec = run_one(tmp_path, Unreachable())
    assert rec.view()["state"] == "failed" and rec.view()["error"] == "runner_error"
    assert rec.view()["container_removed"] is True


def test_terminal_record_releases_input_payload_without_losing_identity(tmp_path):
    submitted = spec(files={"assignments.csv": "private typed input"})
    sup, rec = run_one(tmp_path, FakeDocker(behavior=Behavior(stdout=frame(b"{}"))), submitted)
    assert rec.spec.files == {} and rec.spec.code == ""
    assert rec.view()["code_sha256"] == submitted.code_sha256
    assert sup.submit(submitted) == (rec, False)
    with pytest.raises(JobConflict):
        sup.submit(replace(submitted, files={"assignments.csv": "changed"}))


def test_attach_exception_still_reaps_cli_closes_pipes_and_removes_container(tmp_path):
    class FaultyAttach(FakeDocker):
        def popen(self, args):
            proc = super().popen(args)
            original = proc.wait
            first = True

            def fail_once(timeout=None):
                nonlocal first
                if first:
                    first = False
                    raise RuntimeError("attach wait failed")
                return original(timeout)

            proc.wait = fail_once
            return proc

    fake = FaultyAttach(behavior=Behavior(duration=None))
    sup = Supervisor(settings(tmp_path), docker=fake)
    sup.refresh_health()
    rec, _ = sup.submit(spec())
    sup.q.get_nowait()
    with pytest.raises(RuntimeError, match="attach wait failed"):
        sup.execute(rec)
    proc = next(iter(fake.procs.values()))
    assert proc.returncode is not None and proc.stdout.closed and proc.stderr.closed
    assert rec.view()["state"] == "failed" and rec.view()["container_removed"] is True
    assert rec.spec.files == {} and not fake.containers


def test_concurrent_start_calls_create_only_one_worker_pool(tmp_path):
    entered, release = threading.Event(), threading.Event()

    class SlowStartup(FakeDocker):
        def run(self, args, timeout=20.0):
            if args[0] == "ps" and "--format" in args:
                entered.set()
                assert release.wait(2)
            return super().run(args, timeout)

    sup = Supervisor(settings(tmp_path), docker=SlowStartup())
    threads = [threading.Thread(target=sup.start) for _ in range(2)]
    threads[0].start()
    assert entered.wait(1)
    threads[1].start()
    release.set()
    for worker in threads:
        worker.join(2)
        assert not worker.is_alive()
    try:
        assert len(sup._workers) == sup.s.concurrency + 1
        assert sup.health()["status"] == "ok"
    finally:
        sup.stop()
