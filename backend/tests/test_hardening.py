"""Hardening round: gate amplification limits, strict runner-response validation, global budgets,
search coalescing, story in-flight bookkeeping, evidence-only containment flags, Other-last
ordering and short_title."""
from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid

import httpx
import pytest

from logless.sandbox.client import (JobResult, RunnerClient, SandboxInvalidResponse, display_image, receipt,
                                    validate_job)

from sandbox_helpers import tmp_data  # noqa: F401


# (gate amplification / structural limits are covered in test_gate.py)


# ---------------------------------------------------------------- 2. runner responses

CODE = "print(1)\n"
SHA = hashlib.sha256(CODE.encode()).hexdigest()


def runner_doc(**kw):
    d = {"job_id": str(uuid.uuid4()), "kind": "analysis", "state": "succeeded", "exit_code": 0,
         "started_at": "2026-09-27T01:00:00.000Z", "finished_at": "2026-09-27T01:00:01.000Z", "elapsed_ms": 1000,
         "timed_out": False, "container_removed": True, "runtime": "runsc",
         "image": "logless-analysis:1@sha256:" + "ab" * 32, "output": "{}", "output_bytes": 2, "stderr_tail": "",
         "error": None, "host": "logless-sandbox", "code_sha256": SHA,
         "limits": {"cpus": 1, "memory_mb": 512, "pids": 64, "timeout_s": 10.0, "network": "none", "read_only_root": True}}
    d.update(kw)
    return d


def test_valid_runner_response_passes():
    d = runner_doc()
    assert validate_job(d, job_id=d["job_id"], code_sha256=SHA).state == "succeeded"


@pytest.mark.parametrize("mutation", [
    {"error": "user 17 has 4 complaints"},          # free text in an enum field
    {"runtime": "gvisor-but-trust-me"},
    {"host": "x" * 300},
    {"started_at": "yesterday, when Alice asked"},
    {"exit_code": 10**9},
    {"state": "succeeded", "container_removed": False},
    {"state": "failed", "error": "nonzero_exit"},     # failed but carries output
    {"extra_leak": "c_0123456789ab"},
    {"code_sha256": "0" * 64},                         # a different program than we submitted
    {"elapsed_ms": True},
])
def test_invalid_runner_responses_rejected(mutation):
    d = runner_doc(**mutation)
    with pytest.raises(SandboxInvalidResponse):
        validate_job(d, job_id=d["job_id"], code_sha256=SHA)


def test_mismatched_job_id_rejected():
    d = runner_doc()
    with pytest.raises(SandboxInvalidResponse):
        validate_job(d, job_id=str(uuid.uuid4()), code_sha256=SHA)


def test_client_validates_over_http(tmp_data):
    job_id = str(uuid.uuid4())
    bad = runner_doc(job_id=job_id, host="h", error="free text")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"job_id": job_id, "state": "queued"})
        return httpx.Response(200, json=bad)
    c = RunnerClient(base_url="http://runner", token="t", transport=httpx.MockTransport(handler))
    with pytest.raises(SandboxInvalidResponse):
        c.wait(job_id, SHA, timeout=2)


def test_receipt_display_metadata_is_app_side(monkeypatch):
    d = runner_doc(image="evil/image:1@sha256:" + "cd" * 32, host="attacker-chosen-label")
    monkeypatch.delenv("SANDBOX_IMAGE_DIGEST", raising=False)
    rc = receipt(JobResult(d), SHA, timeout_s=2.0, memory_mb=256)
    assert rc["image"] == "logless-analysis:1" and rc["host"] == "logless-sandbox"
    assert rc["limits"]["timeout_s"] == 2.0 and rc["limits"]["memory_mb"] == 256 and rc["code_sha256"] == SHA
    monkeypatch.setenv("SANDBOX_IMAGE_DIGEST", "sha256:" + "ab" * 32)
    assert display_image("logless-analysis:1@sha256:" + "ab" * 32) == "logless-analysis:1@sha256:" + "ab" * 32
    assert display_image("logless-analysis:1@sha256:" + "cd" * 32) == "logless-analysis:1"


# ---------------------------------------------------------------- 6. containment evidence

def test_containment_flags_only_from_evidence(tmp_data):
    from logless.sandbox.containment import FIXED_PLAN, run_containment, task_source
    from logless.sandbox.runs import Run, load
    from programs import job, run_locally
    from qhelpers import df_for, files_for, inputs_for, published_nodes

    import json

    df = df_for(11)
    inp = inputs_for(df)
    _, followup_out, _ = run_locally(task_source("followup.py"), files_for(df, FIXED_PLAN))
    _, leak_out, _ = run_locally(task_source("leak_attempt.py"), files_for(df, FIXED_PLAN))
    # the destructive fixture's own report, as observed inside a read-only container
    destructive_report = json.dumps({"command": "rm -rf --no-preserve-root /", "ran": True, "rm_exit_code": 1,
                                     "refused": 11089, "root_writable": False, "python_present": True})

    class Scripted:
        def __init__(self, results):
            self.results = list(results)

        def run(self, **kw):
            return self.results.pop(0)

    def go(results, health="ok"):
        run = Run.create("containment", None, "snap_20260926T120000_abcd")
        run_containment(run, snapshot_id="snap_20260926T120000_abcd", health=lambda: health, nodes=published_nodes(df),
                        runner=Scripted(results), inputs=inp)
        return load(run.id)

    killed = job(state="timed_out", error="timeout", timed_out=True, elapsed=2050, exit_code=137)
    destructive = job(output=destructive_report)   # the fixture exits 0 after recording rm's exit code 1
    d = go([killed, destructive, job(output=followup_out), job(output=leak_out)])
    assert d["state"] == "completed", d["error"]
    assert [s["name"] for s in d["stages"]] == ["runaway", "cleanup", "health", "destructive", "followup", "leak_attempt"]
    dd = d["containment"]["destructive"]
    assert dd == {"command": "rm -rf --no-preserve-root /", "exit_code": 1, "refused": 11089, "container_removed": True,
                  "root_read_only": True, "binaries_intact": True, "next_run_clean": True, "contained": True}
    assert d["containment"]["followup_passed"] and d["containment"]["leak_attempt_rejected"]
    assert d["containment"]["leak_rejection_checks"] == ["Only allowlisted field names", "Schema matches exactly"]

    # A successful follow-up from a different image cannot prove recovery of the tested image.
    different_image = job(output=followup_out)
    different_image.raw["image"] = "logless-analysis:1@sha256:" + "cd" * 32
    d = go([killed, destructive, different_image, job(output=leak_out)])
    assert d["state"] == "failed" and d["containment"]["followup_passed"] is True
    assert d["containment"]["destructive"]["next_run_clean"] is False
    assert d["containment"]["destructive"]["contained"] is False

    # the destructive report is untrusted: even a lying "all fine" report can't make it contained
    # if the outside evidence is missing (container not removed).
    not_removed = job(output=json.dumps({"command": "rm -rf --no-preserve-root /", "ran": True, "rm_exit_code": 0,
                                        "refused": 0, "root_writable": False, "python_present": True}))
    not_removed.raw["container_removed"] = False
    d = go([killed, not_removed, job(output=followup_out), job(output=leak_out)])
    assert d["state"] == "failed" and d["error"]["code"] == "containment_check_failed"
    assert d["containment"]["destructive"]["contained"] is False
    assert d["containment"]["destructive"]["container_removed"] is False
    assert "destructive" in d["error"]["message"]

    # the fixture refused to run (not inside the gVisor sandbox): never reported as absorbed
    refused_to_run = job(output=json.dumps({"command": "rm -rf --no-preserve-root /", "ran": False}))
    d = go([killed, refused_to_run, job(output=followup_out), job(output=leak_out)])
    assert d["state"] == "failed" and d["error"]["code"] == "containment_check_failed"
    dd = d["containment"]["destructive"]
    assert dd["contained"] is False and dd["exit_code"] is None and dd["refused"] is None
    assert dd["root_read_only"] is None and dd["binaries_intact"] is None
    assert next(s for s in d["stages"] if s["name"] == "destructive")["detail"].startswith("the fixture refused to run")

    # ill-typed inside report values are dropped, not trusted
    odd = job(output=json.dumps({"command": "rm -rf --no-preserve-root /", "ran": True, "rm_exit_code": True,
                                 "refused": -3, "root_writable": False, "python_present": True}))
    d = go([killed, odd, job(output=followup_out), job(output=leak_out)])
    assert d["containment"]["destructive"]["exit_code"] is None and d["containment"]["destructive"]["refused"] is None

    # leak fixture times out: the gate never saw output, so it was NOT a rejection
    d = go([killed, destructive, job(output=followup_out), job(state="timed_out", error="timeout", timed_out=True, elapsed=10040)])
    assert d["state"] == "failed" and d["error"]["code"] == "leak_fixture_failed"
    assert d["containment"]["leak_attempt_rejected"] is False and d["containment"]["leak_rejection_checks"] == []
    assert d["containment"]["killed"] is True and d["containment"]["destructive"]["contained"] is True

    # runaway finished on its own, follow-up failed, health degraded: flags false, run failed
    d = go([job(state="failed", error="nonzero_exit"), destructive, job(state="failed", error="nonzero_exit"), job(output=leak_out)],
           health="degraded")
    c = d["containment"]
    assert d["state"] == "failed" and d["error"]["code"] == "containment_check_failed"
    assert c["killed"] is False and c["app_health"] == "degraded" and c["followup_passed"] is False
    assert c["destructive"]["next_run_clean"] is False and c["destructive"]["contained"] is False
    assert c["leak_attempt_rejected"] is True   # this one was a real gate rejection
    assert "not killed" in d["error"]["message"] and "follow-up" in d["error"]["message"]


# ---------------------------------------------------------------- 3 + 5. budgets, coalescing, story bookkeeping

def test_hourly_budget():
    from logless.api.ratelimit import HourlyBudget
    b = HourlyBudget({"search": 2})
    assert b.take("search") is None and b.take("search") is None
    retry = b.take("search")
    assert retry is not None and 1 <= retry <= 3601
    assert b.remaining("search") == 0


def test_short_title(tmp_data):
    from logless.api import serializers
    assert serializers.short_title(None, "Planning trips") == "Planning trips"
    st = serializers.short_title(None, "Coordinating care for an aging parent across siblings")
    assert len(st) <= 24 and st.endswith("…") and st.startswith("Coordinating care")
    assert serializers.short_title("  Care   coordination ", "x") == "Care coordination"
    assert len(serializers.short_title("y" * 40, "x")) <= 24


def test_inputs_are_frozen_at_publication(tmp_data):
    """Live questions answer over the rows as they were when the snapshot was published, even if the
    pipeline re-labels friction afterwards."""
    import json as _json
    import subprocess
    import sys
    from pathlib import Path

    from logless import db
    from logless.sandbox.analysis import load_inputs
    repo = Path(__file__).resolve().parents[2]
    r = subprocess.run([sys.executable, str(repo / "backend/scripts/dev_snapshot.py"), "--data-dir", str(tmp_data), "--n", "80"],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    sid = _json.loads(r.stdout.strip().splitlines()[-1])["snapshot_id"]
    cols = ["leaf_id", "category_id", "correction", "repeat_request", "assistant_limit", "complaint"]
    before = sorted(map(tuple, load_inputs(sid).df[cols].values.tolist()))
    con = db.private()
    with db.write(con):
        con.execute("UPDATE friction SET choice = 'observed'")      # a later re-labelling
    after = sorted(map(tuple, load_inputs(sid).df[cols].values.tolist()))
    assert before == after and any(t[2] != "observed" for t in after)
