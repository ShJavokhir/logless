"""run_aggregate end to end (fake runner that executes the real task locally) and exact parity with
the pipeline's own trusted reference, which stage 5 compares against before publishing."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from logless.sandbox import aggregate as agg
from logless.sandbox.client import JobResult
from logless.sandbox.export import load_cluster_map

from sandbox_helpers import tmp_data  # noqa: F401

REPO = Path(__file__).resolve().parents[2]


class LocalTaskRunner:
    """Executes the submitted program with python on this machine, /in and /out rewritten to temp dirs."""

    def __init__(self, tmp: Path, tamper=None):
        self.tmp, self.tamper = tmp, tamper

    def run(self, *, kind, code, files, timeout_s, memory_mb=512):
        d_in, d_out = self.tmp / "in", self.tmp / "out"
        d_in.mkdir(exist_ok=True)
        d_out.mkdir(exist_ok=True)
        for k, v in files.items():
            (d_in / k).write_text(v)
        src = code.replace("/in/", f"{d_in}/").replace("/out/", f"{d_out}/")
        subprocess.run([sys.executable, "-c", src], check=True, timeout=60, env=dict(os.environ))
        out = (d_out / "result.json").read_text()
        if self.tamper:
            out = self.tamper(out)
        return JobResult({"job_id": "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f", "kind": kind, "state": "succeeded", "exit_code": 0,
                          "started_at": "2026-09-27T01:00:00.000Z", "finished_at": "2026-09-27T01:00:01.500Z",
                          "elapsed_ms": 1500, "timed_out": False, "container_removed": True, "runtime": "runsc",
                          "image": "logless-analysis:1@sha256:x", "output": out, "output_bytes": len(out), "stderr_tail": "",
                          "error": None, "host": "sandbox", "code_sha256": "0" * 64,
                          "limits": {"cpus": 1, "memory_mb": 512, "pids": 64, "timeout_s": timeout_s, "network": "none", "read_only_root": True}})


@pytest.fixture()
def fixture_build(tmp_data):
    r = subprocess.run([sys.executable, str(REPO / "backend/scripts/dev_snapshot.py"), "--data-dir", str(tmp_data), "--n", "250"],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    info = json.loads(r.stdout.strip().splitlines()[-1])
    _, clusters = load_cluster_map(info["snapshot_id"])
    return info, clusters


def test_run_aggregate_matches_pipeline_reference(fixture_build, tmp_path):
    info, clusters = fixture_build
    snap = "snap_20260927T000000_beef"
    res = agg.run_aggregate(info["build_id"], clusters, snap, runner=LocalTaskRunner(tmp_path))
    assert res["verdict"]["passed"] and res["receipt"]["runtime"] == "runsc"
    from logless.pipeline import stats
    ref = stats.reference_metrics(stats.assignment_rows(info["build_id"], clusters), clusters)
    for c in clusters:                       # the exact comparison pipeline.stats.run performs
        assert res["metrics"][c["id"]] == ref[c["id"]], c["id"]
    assert res["metrics"]["total"] == ref["total"]
    assert load_cluster_map(snap)[0] == info["build_id"]   # live analyses can find this snapshot's inputs


def test_run_aggregate_rejects_tampered_output(fixture_build, tmp_path):
    info, clusters = fixture_build

    def tamper(out: str) -> str:
        doc = json.loads(out)
        doc["nodes"][0]["users"] += 1
        return json.dumps(doc)
    with pytest.raises(agg.AggregateRejected) as e:
        agg.run_aggregate(info["build_id"], clusters, "snap_20260927T000000_beef", runner=LocalTaskRunner(tmp_path, tamper))
    assert "Counts match the trusted reference" in str(e.value)
    assert e.value.verdict["passed"] is False


def test_run_aggregate_runner_unreachable(fixture_build):
    from logless.sandbox.client import RunnerClient, SandboxUnavailable
    info, clusters = fixture_build
    with pytest.raises(SandboxUnavailable):
        agg.run_aggregate(info["build_id"], clusters, "snap_20260927T000000_beef",
                          runner=RunnerClient(base_url="http://127.0.0.1:9", token="x"))
