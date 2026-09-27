"""Regression cases from the reliability review; no network or generated code execution."""
from __future__ import annotations

import json
import gzip
import copy

import httpx
import pytest

from logless.sandbox import export, gate
from logless.sandbox.client import RunnerClient, SandboxInvalidResponse, validate_job

from qhelpers import CL, SNAP, df_for, oracle_answer, public_structure, published_nodes
from test_gate import check, good
from test_hardening import CODE, SHA, runner_doc


@pytest.mark.parametrize("measure", ["conversations", "people"])
def test_no_filter_requires_counts_equal_bases(measure):
    plan = dict(good()["plan"], measure=measure, signal=None)
    doc = good(plan)
    doc["rows"][0]["count"] = 0
    doc["rows"][0]["share"] = 0.0
    doc["total_count"] -= 1
    verdict = check(doc, plan)
    assert gate.C_ARITH in verdict.failed_names
    assert gate.C_TOTALS in verdict.failed_names


@pytest.mark.parametrize("n", [2**53, 10**400, -(10**400)])
def test_extreme_numbers_rejected_without_arithmetic_crash(n):
    doc = good()
    doc["rows"][0]["count"] = n
    verdict = check(doc)
    assert verdict.failed_names == [gate.C_SHAPE]
    assert str(n) not in json.dumps(verdict.public())


def test_invalid_unicode_is_a_gate_rejection():
    verdict = check('{"intent":"\ud800"}')
    assert verdict.failed_names == [gate.C_PARSE]


def test_distinct_people_total_cannot_exceed_all_groups_combined():
    plan = dict(good()["plan"], limit=10)
    doc = good(plan)
    doc["total_base"] = sum(r["base"] for r in doc["rows"]) + 1
    assert gate.C_TOTALS in check(doc, plan).failed_names


@pytest.mark.parametrize("signal,measure,rank_by", [
    (None, "conversations", "count"), (None, "people", "share"),
    ("complaint", "conversations", "count"), ("any_friction", "conversations", "share"),
])
def test_valid_but_wrong_top_group_is_rejected_against_published_map(signal, measure, rank_by):
    df = df_for(7)
    plan = dict(good()["plan"], scope_category_id=None, signal=signal, measure=measure, rank_by=rank_by, limit=10)
    doc = oracle_answer(df, plan)
    plan["limit"] = 1
    doc["plan"] = plan
    doc["rows"] = doc["rows"][-1:]
    verdict = check(doc, plan)
    assert verdict.passed  # the row is internally correct, but it is not the top group
    checks = gate.check_snapshot(verdict.canonical, plan=plan, clusters=public_structure(CL), nodes=published_nodes(df))
    failed = [c.name for c in checks if not c.passed]
    assert failed == [gate.map_check_name("top groups = published ranking")]


def test_snapshot_export_never_falls_back_to_live_assignments(monkeypatch):
    monkeypatch.setattr(export, "_load_frozen", lambda sid: None)
    monkeypatch.setattr(export, "_load_rows", lambda build: pytest.fail("must not read mutable assignments"))
    with pytest.raises(export.ExportError, match="frozen"):
        export.export_inputs("build", CL, snapshot_id=SNAP)


def test_ambiguous_theme_assignment_is_rejected():
    clusters = copy.deepcopy(CL)
    leaves = [c for c in clusters if c["level"] == 2]
    leaves[0]["theme_ids"] = leaves[1]["theme_ids"] = ["same-theme"]
    with pytest.raises(export.ExportError, match="theme belongs"):
        export._validate_structure(clusters)


@pytest.mark.parametrize("mutation", [
    {"runtime": "runc"}, {"runtime": None}, {"timed_out": True}, {"error": "timeout"},
    {"output_bytes": 1}, {"output": "\ud800", "output_bytes": 1},
    {"output": "é" * 600_000, "output_bytes": 1_200_000}, {"image": "unverified"},
    {"state": "timed_out", "output": None, "timed_out": False, "error": "timeout"},
])
def test_inconsistent_success_or_timeout_receipts_are_rejected(monkeypatch, mutation):
    monkeypatch.delenv("SANDBOX_RUNTIME", raising=False)
    doc = runner_doc(**mutation)
    with pytest.raises(SandboxInvalidResponse):
        validate_job(doc, job_id=doc["job_id"], code_sha256=SHA)


def test_local_runc_requires_explicit_app_configuration(monkeypatch):
    monkeypatch.setenv("SANDBOX_RUNTIME", "runc")
    doc = runner_doc(runtime="runc")
    assert validate_job(doc, job_id=doc["job_id"], code_sha256=SHA).runtime == "runc"


def test_pinned_image_must_match_the_actual_receipt(monkeypatch):
    monkeypatch.setenv("SANDBOX_IMAGE_DIGEST", "sha256:" + "cd" * 32)
    doc = runner_doc()
    with pytest.raises(SandboxInvalidResponse, match="unexpected_image"):
        validate_job(doc, job_id=doc["job_id"], code_sha256=SHA)


@pytest.mark.parametrize("mutation", [{"kind": "containment"}, {"timeout_s": 10.0}, {"memory_mb": 512}, {"cpus": 2}, {"pids": 128}])
def test_http_run_binds_receipt_to_requested_kind_and_limits(tmp_data, mutation):
    submitted = {}

    def handler(request):
        if request.method == "POST":
            submitted.update(json.loads(request.content))
            return httpx.Response(202, json={"job_id": submitted["job_id"], "state": "queued"})
        doc = runner_doc(job_id=submitted["job_id"], kind=submitted["kind"])
        doc["limits"].update(timeout_s=submitted["timeout_s"], memory_mb=submitted["memory_mb"])
        if "kind" in mutation:
            doc.update(mutation)
        else:
            doc["limits"].update(mutation)
        return httpx.Response(200, json=doc)

    client = RunnerClient(base_url="http://runner", token="test", transport=httpx.MockTransport(handler))
    with pytest.raises(SandboxInvalidResponse):
        client.run(kind="analysis", code=CODE, files={}, timeout_s=2.0, memory_mb=256)


def test_runner_response_stream_is_bounded_before_json_parse(tmp_data, monkeypatch):
    monkeypatch.setattr("logless.sandbox.client.MAX_RESPONSE_BYTES", 100)
    doc = runner_doc()
    client = RunnerClient(base_url="http://runner", token="test", transport=httpx.MockTransport(
        lambda request: httpx.Response(200, content=b" " * 200)))
    with pytest.raises(SandboxInvalidResponse, match="response_too_large"):
        client.get(doc["job_id"], SHA)


def test_compressed_runner_reply_is_decoded_once(tmp_data):
    doc = runner_doc()
    body = gzip.compress(json.dumps(doc).encode())
    client = RunnerClient(base_url="http://runner", token="test", transport=httpx.MockTransport(
        lambda request: httpx.Response(200, content=body, headers={"Content-Encoding": "gzip"})))
    assert client.get(doc["job_id"], SHA).state == "succeeded"


def test_health_is_degraded_when_runtime_disagrees(tmp_data, monkeypatch):
    monkeypatch.delenv("SANDBOX_RUNTIME", raising=False)
    client = RunnerClient(base_url="http://runner", token="test", transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={"status": "ok", "runtime": "runc"})))
    assert client.health() == {"status": "degraded"}
