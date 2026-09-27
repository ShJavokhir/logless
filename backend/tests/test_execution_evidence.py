"""Unstarted jobs must not become fabricated execution receipts or containment evidence."""
import pytest

from logless.sandbox.client import JobResult, SandboxInvalidResponse, receipt, validate_job
from logless.sandbox.containment import run_containment
from logless.sandbox.runs import Run, load

from qhelpers import SNAP, df_for, inputs_for, published_nodes
from test_hardening import SHA, runner_doc
from test_question import CONV_PLAN, FakeGLM, run_q


def unstarted(error, runtime=None):
    return JobResult(runner_doc(state="failed", error=error, runtime=runtime, started_at=None,
                                elapsed_ms=None, exit_code=None, output=None, output_bytes=0))


@pytest.mark.parametrize("error,runtime", [
    ("runner_error", None), ("image_missing", "runsc"), ("container_create_failed", "runsc"),
])
def test_no_receipt_without_execution_start(error, runtime):
    assert receipt(unstarted(error, runtime), SHA, timeout_s=10) is None


def test_started_job_without_observed_runtime_has_no_fabricated_runtime():
    res = JobResult(runner_doc(state="failed", error="runner_error", runtime=None, output=None, output_bytes=0))
    with pytest.raises(SandboxInvalidResponse, match="unverified_execution"):
        receipt(res, SHA, timeout_s=10)
    with pytest.raises(SandboxInvalidResponse, match="unverified_execution"):
        validate_job(res.raw, job_id=res["job_id"], code_sha256=SHA)


def test_started_failure_keeps_actual_runtime_and_execution_receipt():
    res = JobResult(runner_doc(state="failed", error="nonzero_exit", exit_code=1, output=None, output_bytes=0))
    got = receipt(res, SHA, timeout_s=10)
    assert got["runtime"] == "runsc" and got["elapsed_ms"] == 1000 and got["exit_code"] == 1


def test_partial_execution_timing_is_unverifiable_not_never_started():
    res = JobResult(runner_doc(state="failed", error="runner_error", started_at=None, output=None, output_bytes=0))
    with pytest.raises(SandboxInvalidResponse, match="unverified_execution"):
        receipt(res, SHA, timeout_s=10)


class Scripted:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def run(self, **kw):
        self.calls.append(kw)
        assert self.results, "must not submit further jobs after execution evidence is unavailable"
        return self.results.pop(0)


@pytest.mark.parametrize("error,runtime", [("runner_error", None), ("image_missing", "runsc")])
def test_analysis_has_zero_executions_and_no_code_repair_for_unstarted_jobs(tmp_data, monkeypatch, error, runtime):
    fake = FakeGLM({"plan": CONV_PLAN})
    runner = Scripted(unstarted(error, runtime), unstarted(error, runtime))
    doc, _ = run_q(monkeypatch, "What's not working?", fake, runner=runner)
    assert doc["state"] == "failed" and doc["error"]["code"] == "sandbox_unavailable"
    assert doc["attempts"] == 0 and doc["receipt"] is None and doc["result"] is None
    assert len(doc["attempts_log"]) == 2 and all(a["receipt"] is None for a in doc["attempts_log"])
    assert all("job did not start" in a["verdict"]["checks"][0]["detail"] for a in doc["attempts_log"])
    assert "repairing" not in [s["name"] for s in doc["stages"]]
    assert len(runner.calls) == 2


def test_unverifiable_started_job_fails_without_a_not_executed_attempt(tmp_data, monkeypatch):
    bad = JobResult(runner_doc(state="failed", error="runner_error", runtime=None, output=None, output_bytes=0))
    doc, _ = run_q(monkeypatch, "What's not working?", FakeGLM({"plan": CONV_PLAN}), runner=Scripted(bad, bad))
    assert doc["error"]["code"] == "sandbox_invalid_response"
    assert "could not be verified" in doc["error"]["message"]
    assert doc["attempts_log"] == []  # null receipts in attempt logs mean never executed


@pytest.mark.parametrize("error,runtime", [("runner_error", None), ("image_missing", "runsc")])
def test_containment_stops_without_claiming_execution_or_cleanup(tmp_data, error, runtime):
    run = Run.create("containment", None, SNAP)
    df = df_for(1)
    runner = Scripted(unstarted(error, runtime))
    run_containment(run, snapshot_id=SNAP, health=lambda: "ok", nodes=published_nodes(df),
                    runner=runner, inputs=inputs_for(df))
    doc = load(run.id)
    assert doc["state"] == "failed" and doc["error"]["code"] == "sandbox_unavailable"
    assert doc["attempts"] == 0 and doc["receipt"] is None
    assert doc["containment"]["killed"] is False and doc["containment"]["container_removed"] is False
    assert doc["containment"]["destructive"] is None
    assert "job did not start" in doc["stages"][0]["detail"]
    assert len(runner.calls) == 1


def test_later_unstarted_containment_job_does_not_increment_execution_count(tmp_data):
    run = Run.create("containment", None, SNAP)
    df = df_for(1)
    first = JobResult(runner_doc(kind="containment", state="timed_out", error="timeout", timed_out=True,
                                 exit_code=137, elapsed_ms=2050, output=None, output_bytes=0))
    runner = Scripted(first, unstarted("image_missing", "runsc"))
    run_containment(run, snapshot_id=SNAP, health=lambda: "ok", nodes=published_nodes(df),
                    runner=runner, inputs=inputs_for(df))
    doc = load(run.id)
    assert doc["state"] == "failed" and doc["attempts"] == 1
    assert doc["receipt"]["job_id"] == first["job_id"]
    assert doc["containment"]["killed"] is True and doc["containment"]["destructive"] is None
    assert len(runner.calls) == 2
