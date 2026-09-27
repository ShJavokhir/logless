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

from logless.sandbox import gate, reference
from logless.sandbox.client import (JobResult, RunnerClient, SandboxInvalidResponse, display_image, receipt,
                                    validate_job)

from sandbox_helpers import CATS, CLUSTERS, LEAVES, SNAP, make_df, tmp_data  # noqa: F401


# ---------------------------------------------------------------- 1. gate amplification

def _gate(text, intent="usage", df=None):
    df = make_df() if df is None else df
    ref = reference.usage(df, LEAVES, SNAP) if intent == "usage" else reference.friction(df, LEAVES, SNAP)
    return gate.check(text, intent=intent, snapshot_id=SNAP, leaf_ids=LEAVES, category_ids=CATS, reference=ref)


def test_deeply_nested_output_is_rejected_cheaply():
    # ~850 nested objects around a list of many long strings: previously every string produced a
    # diagnostic carrying the full nested path (GBs of text). Now the structure check stops it.
    inner = json.dumps(["x" * 900] * 900)
    text = '{"rows": ' + '{"a": ' * 850 + inner + "}" * 850 + "}"
    assert len(text) < 1024 * 1024
    t0 = time.monotonic()
    v = _gate(text)
    assert time.monotonic() - t0 < 1.0
    assert not v.passed and v.failed_names in (["Strict JSON parse"], [gate.C_SHAPE])
    assert len(json.dumps(v.public())) < 2000


@pytest.mark.parametrize("doc,reason", [
    ({"rows": [[[[[[["x"]]]]]]]}, "nested deeper"),
    ({"rows": [{"cluster_id": "c" * 65}]}, "longer than 64"),
    ({"rows": list(range(1001))}, "more than 1000 entries"),
    ({f"k{i}": 1 for i in range(33)}, "more than 32 fields"),
])
def test_structural_limits(doc, reason):
    v = _gate(json.dumps(doc))
    assert v.failed_names == [gate.C_SHAPE] and reason in v.checks[-1].detail


def test_diagnostics_are_bounded():
    rows = [{"cluster_id": f"cl_{i:06x}", "conversations": 1, "users": 1, "share": 0.1, f"x{i}": 1} for i in range(1000)]
    v = _gate(json.dumps({"intent": "usage", "snapshot_id": SNAP, "total_conversations": 1, "rows": rows}))
    for c in v.checks:
        assert len(c.detail) < 400
    fields = next(c for c in v.checks if c.name == gate.C_FIELDS)
    assert "(+997 more)" in fields.detail


# ---------------------------------------------------------------- Other-last ordering

def test_other_is_always_last_in_reference_and_gate():
    df = make_df()
    df.loc[:, "leaf_id"] = "cl_other"  # make the catch-all by far the largest
    df.loc[df.index[:5], "leaf_id"] = "cl_111111"
    for fn, intent in ((reference.usage, "usage"), (reference.friction, "friction")):
        ref = fn(df, LEAVES, SNAP)
        assert ref["rows"][-1]["cluster_id"] == "cl_other"
        good = reference.rounded(ref)
        assert _gate(json.dumps(good), intent, df).passed
        metric = "conversations" if intent == "usage" else "friction_conversations"
        naive = dict(good, rows=sorted(good["rows"], key=lambda r: (-r[metric], r["cluster_id"])))
        v = _gate(json.dumps(naive), intent, df)
        assert v.failed_names == [gate.C_ORDER[intent]]


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
    from logless.sandbox.containment import run_containment
    from logless.sandbox.runs import Run, load
    from test_sandbox_analysis import FakeRunner, inputs, job

    inp = inputs()
    # leak fixture times out: the gate never saw output, so it was NOT a rejection
    runner = FakeRunner([job(state="timed_out", error="timeout", timed_out=True, elapsed=2050),
                         job(output=json.dumps(reference.rounded(reference.usage(inp.df, LEAVES, SNAP)))),
                         job(state="timed_out", error="timeout", timed_out=True, elapsed=10040)])
    run = Run.create("containment", None, SNAP)
    run_containment(run, snapshot_id=SNAP, health=lambda: "ok", runner=runner, inputs=inp)
    d = load(run.id)
    assert d["state"] == "failed" and d["error"]["code"] == "leak_fixture_failed"
    assert d["containment"]["leak_attempt_rejected"] is False and d["containment"]["leak_rejection_checks"] == []
    assert d["containment"]["killed"] is True and d["containment"]["followup_passed"] is True

    # runaway finished on its own (not killed) and health degraded: flags false, run failed
    runner = FakeRunner([job(state="failed", error="nonzero_exit"), job(state="failed", error="nonzero_exit"),
                         job(output=json.dumps({"rows": [{"user": 1}]}))])
    run = Run.create("containment", None, SNAP)
    run_containment(run, snapshot_id=SNAP, health=lambda: "degraded", runner=runner, inputs=inp)
    d = load(run.id)
    c = d["containment"]
    assert d["state"] == "failed" and d["error"]["code"] == "containment_check_failed"
    assert c["killed"] is False and c["app_health"] == "degraded" and c["followup_passed"] is False
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
