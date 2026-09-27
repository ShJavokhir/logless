"""Supervisor unit tests against an in-process fake docker CLI."""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import replace
from pathlib import Path

import pytest

from logless_runner import config
from logless_runner.docker import Docker
from logless_runner.supervisor import JobConflict, JobSpec, Quarantined, Supervisor, parse_frame

from .fakes import Behavior, FakeDocker, frame


def settings(tmp_path: Path, **kw) -> config.Settings:
    base = config.Settings(token="t0k", bind="127.0.0.1:0", runtime="runsc", image="logless-analysis:1", image_digest="",
                           work_dir=tmp_path / "jobs", concurrency=2, result_ttl_s=900, docker_bin="docker",
                           tmp_tmpfs=config.TMP_TMPFS, out_tmpfs=config.OUT_TMPFS)
    return replace(base, **kw)


def spec(**kw) -> JobSpec:
    d = dict(job_id=str(uuid.uuid4()), kind="analysis", code="print('hi')\n", files={"assignments.csv": "row,user\n1,2\n"},
             timeout_s=2.0, memory_mb=512)
    d.update(kw)
    return JobSpec(**d)


def run_one(tmp_path: Path, fake: FakeDocker, s: JobSpec | None = None, **kw):
    sup = Supervisor(settings(tmp_path, **kw), docker=fake)
    sup.work_dir_created = sup.s.work_dir.mkdir(parents=True, exist_ok=True)
    sup.refresh_health(force=True)
    s = s or spec()
    rec, created = sup.submit(s)
    assert created
    sup.q.get_nowait()
    sup.execute(rec)
    return sup, rec


def test_success_collects_output_and_removes_container(tmp_path):
    body = json.dumps({"intent": "usage"}).encode()
    fake = FakeDocker(behavior=Behavior(stdout=frame(body), stderr=b"warn\n"))
    sup, rec = run_one(tmp_path, fake)
    v = rec.view()
    assert v["state"] == "succeeded" and v["error"] is None
    assert v["output"] == body.decode() and v["output_bytes"] == len(body)
    assert v["container_removed"] is True and fake.containers == {}
    assert v["runtime"] == "runsc" and v["image"].startswith("logless-analysis:1@sha256:")
    assert v["exit_code"] == 0 and v["timed_out"] is False
    assert v["limits"] == {"cpus": 1, "memory_mb": 512, "pids": 64, "timeout_s": 2.0, "network": "none", "read_only_root": True}
    assert list((tmp_path / "jobs").iterdir()) == []  # job dir deleted


def test_container_flags_match_contract(tmp_path):
    fake = FakeDocker(behavior=Behavior(stdout=frame(b"{}")))
    s = spec()
    run_one(tmp_path, fake, s)
    create = next(c for c in fake.calls if c[0] == "create")
    for flag in ["--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                 "--pids-limit=64", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--log-driver=none"]:
        assert flag in create, flag
    joined = " ".join(create)
    assert "--tmpfs /tmp:size=64m,nr_inodes=1024" in joined
    assert "--tmpfs /out:size=2m,nr_inodes=16" in joined
    assert "--user 10001:10001" in joined and "--ulimit core=0" in joined and "--ulimit nofile=256" in joined
    assert f"--label logless.job={s.job_id}" in joined
    assert ",target=/in,readonly" in joined
    assert create[-3:] == ["sha256:" + "ab" * 32, "python", "/in/main.py"]  # image pinned by id


def test_timeout_kills_and_removes(tmp_path):
    fake = FakeDocker(behavior=Behavior(duration=None))
    t0 = time.monotonic()
    _, rec = run_one(tmp_path, fake, spec(timeout_s=0.5))
    v = rec.view()
    assert v["state"] == "timed_out" and v["timed_out"] is True and v["output"] is None
    assert 450 <= v["elapsed_ms"] <= 1500
    assert time.monotonic() - t0 < 3
    assert any(c[0] == "kill" for c in fake.calls)
    assert v["container_removed"] is True and fake.containers == {}


def test_nonzero_exit_fails_without_output(tmp_path):
    fake = FakeDocker(behavior=Behavior(stdout=frame(b"", status="skipped", code=1), stderr=b"Traceback...\nKeyError: 'x'\n", exit=1))
    _, rec = run_one(tmp_path, fake)
    v = rec.view()
    assert v["state"] == "failed" and v["error"] == "nonzero_exit" and v["output"] is None
    assert "KeyError" in v["stderr_tail"]


def test_output_too_large(tmp_path):
    big = b"x" * (config.MAX_OUTPUT_BYTES + 10)
    fake = FakeDocker(behavior=Behavior(stdout=frame(big)))
    _, rec = run_one(tmp_path, fake)
    v = rec.view()
    assert v["state"] == "failed" and v["error"] == "output_too_large" and v["output"] is None


def test_bootstrap_reported_too_large_and_symlink(tmp_path):
    fake = FakeDocker(behavior=Behavior(stdout=frame(b"", status="not_regular")))
    _, rec = run_one(tmp_path, fake)
    assert rec.view()["error"] == "output_not_regular_file"


def test_stderr_tail_is_bounded(tmp_path):
    fake = FakeDocker(behavior=Behavior(stdout=frame(b"{}"), stderr=b"e" * 200_000 + b"END"))
    _, rec = run_one(tmp_path, fake)
    tail = rec.view()["stderr_tail"]
    assert len(tail.encode()) <= config.STDERR_TAIL_BYTES and tail.endswith("END")


def test_oom_reported(tmp_path):
    fake = FakeDocker(behavior=Behavior(exit=137, oom=True))
    _, rec = run_one(tmp_path, fake)
    assert rec.view()["error"] == "oom_killed"


def test_missing_image_fails_without_container(tmp_path):
    fake = FakeDocker(image_id="")
    _, rec = run_one(tmp_path, fake)
    v = rec.view()
    assert v["state"] == "failed" and v["error"] == "image_missing"
    assert not any(c[0] == "create" for c in fake.calls)


def test_digest_mismatch_refuses(tmp_path):
    fake = FakeDocker()
    _, rec = run_one(tmp_path, fake, image_digest="sha256:" + "cd" * 32)
    assert rec.view()["error"] == "image_digest_mismatch"


def test_runtime_unavailable_refuses(tmp_path):
    fake = FakeDocker(runtimes=("runc",))
    _, rec = run_one(tmp_path, fake)
    assert rec.view()["state"] == "failed"
    assert not any(c[0] == "create" for c in fake.calls)


def test_unverified_removal_fails_job_and_quarantines(tmp_path):
    fake = FakeDocker(behavior=Behavior(stdout=frame(b'{"ok": 1}')), stuck_containers=True)
    sup, rec = run_one(tmp_path, fake)
    v = rec.view()
    # never "succeeded" and never any output when removal is unverified
    assert v["state"] == "failed" and v["error"] == "cleanup_failed" and v["output"] is None
    assert v["container_removed"] is False
    assert sup.health()["status"] == "degraded" and sup.health()["quarantined"] == 1
    with pytest.raises(Quarantined):
        sup.submit(spec())
    assert sup.reconcile() == 1          # still stuck: quarantine stays
    fake.stuck_containers = False
    assert sup.reconcile() == 0          # docker now confirms removal
    assert sup.health()["quarantined"] == 0
    sup.submit(spec())                   # admission resumes


def test_workers_hold_while_quarantined(tmp_path):
    fake = FakeDocker(behavior=Behavior(stdout=frame(b"{}")))
    sup = Supervisor(settings(tmp_path, concurrency=1), docker=fake)
    rec, _ = sup.submit(spec())
    sup.quarantine["x"] = "logless-job-x"
    sup.start()
    try:
        time.sleep(0.8)
        assert rec.view()["state"] == "queued"   # not started while quarantined
        sup.quarantine.clear()
        deadline = time.monotonic() + 5
        while rec.view()["state"] not in ("succeeded", "failed") and time.monotonic() < deadline:
            time.sleep(0.02)
        assert rec.view()["state"] == "succeeded"
    finally:
        sup.stop()


def test_periodic_reap_spares_running_jobs(tmp_path):
    fake = FakeDocker()
    fake.containers["orphan"] = {"label": "logless.job=dead", "args": [], "exit": None}
    fake.containers["live"] = {"label": "logless.job=alive", "args": [], "exit": None}
    sup = Supervisor(settings(tmp_path), docker=fake)
    sup.active.add("alive")
    assert sup.reap_orphans() == 1
    assert set(fake.containers) == {"live"}


def test_idempotent_submit_and_conflict(tmp_path):
    sup = Supervisor(settings(tmp_path), docker=FakeDocker())
    s = spec()
    r1, c1 = sup.submit(s)
    r2, c2 = sup.submit(s)
    assert c1 and not c2 and r1 is r2
    with pytest.raises(JobConflict):
        sup.submit(replace(s, code="print(2)\n"))


def test_orphans_reaped_on_start(tmp_path):
    fake = FakeDocker()
    fake.containers["old"] = {"label": "logless.job=123", "args": [], "exit": None}
    (tmp_path / "jobs" / "stale").mkdir(parents=True)
    sup = Supervisor(settings(tmp_path, concurrency=1), docker=fake)
    sup.start()
    try:
        assert fake.containers == {}
        assert list((tmp_path / "jobs").iterdir()) == []
    finally:
        sup.stop()


def test_worker_runs_queued_jobs(tmp_path):
    fake = FakeDocker(behavior=Behavior(stdout=frame(b"{}")))
    sup = Supervisor(settings(tmp_path), docker=fake)
    sup.start()
    try:
        rec, _ = sup.submit(spec())
        deadline = time.monotonic() + 5
        while rec.view()["state"] not in ("succeeded", "failed", "timed_out") and time.monotonic() < deadline:
            time.sleep(0.02)
        assert rec.view()["state"] == "succeeded"
    finally:
        sup.stop()


def test_parse_frame():
    assert parse_frame(frame(b'{"a":1}'), len(frame(b'{"a":1}'))) == ("ok", '{"a":1}', 7)
    assert parse_frame(b"garbage\n", 8)[0] == "bad_frame"
    assert parse_frame(b"LOGLESS/1 ok 0 5\nabc", 999)[0] == "too_large"   # more was sent than captured
    assert parse_frame(b"LOGLESS/1 ok 0 5\nabc", 20)[0] == "bad_frame"     # length mismatch
    f = b"LOGLESS/1 ok 0 3\n\xff\xfe\xfd"
    assert parse_frame(f, len(f))[0] == "not_utf8"
    f = b"LOGLESS/1 missing 0 0\n"
    assert parse_frame(f, len(f))[0] == "missing"


def test_docker_env_is_minimal(monkeypatch):
    monkeypatch.setenv("RUNNER_TOKEN", "secret-token")
    monkeypatch.setenv("SOMETHING_ELSE", "x")
    env = Docker().env
    assert "RUNNER_TOKEN" not in env and "SOMETHING_ELSE" not in env and "PATH" in env
