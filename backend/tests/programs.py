"""Test helpers: hand-written stand-ins for the two GLM-written programs (A: pandas, B: standard
library) and a runner that executes submitted programs locally with /in and /out rewritten to
temp dirs. The sandbox itself is tested in runner/."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from logless.sandbox.client import JobResult

TASKS = Path(__file__).resolve().parents[1] / "sandbox_tasks"

# Program A: pandas, written only from the output contract.
PANDAS_PROGRAM = r'''
import json
import pandas as pd
S = ["correction", "repeat_request", "assistant_limit", "complaint"]
df = pd.read_csv("/in/assignments.csv", dtype={"leaf_id": str, "category_id": str, **{s: str for s in S}})
clusters = json.load(open("/in/clusters.json")); contract = json.load(open("/in/contract.json")); plan = contract["plan"]
other_cats = {c["id"] for c in clusters if c["level"] == 1 and c["is_other"]}
leaves = {c["id"]: c["parent_id"] for c in clusters if c["level"] == 2 and not c["is_other"] and c["id"] != "cl_other" and c["parent_id"] not in other_cats}
if plan["scope_category_id"] is not None:
    leaves = {k: v for k, v in leaves.items() if v == plan["scope_category_id"]}
sc = df[df["leaf_id"].isin(set(leaves))]
if plan["signal"] is None: m = pd.Series(True, index=sc.index)
elif plan["signal"] == "any_friction": m = (sc[S] == "observed").any(axis=1)
else: m = sc[plan["signal"]] == "observed"
meas = (lambda x: int(len(x))) if plan["measure"] == "conversations" else (lambda x: int(x["user"].nunique()))
col = "leaf_id" if plan["group_by"] == "leaf" else "category_id"
groups = sorted(leaves) if plan["group_by"] == "leaf" else sorted(set(leaves.values()))
rows = []
for g in groups:
    gg = sc[sc[col] == g]
    c, b = meas(gg[m.loc[gg.index]]), meas(gg)
    rows.append({"id": g, "count": c, "base": b, "share": (c / b) if b else 0.0})
if plan["rank_by"] == "count": rows.sort(key=lambda r: (-r["count"], r["id"]))
else: rows.sort(key=lambda r: (-r["share"], r["id"]))
rows = rows[: plan["limit"]]
for r in rows: r["share"] = round(r["share"], 4)
json.dump({"intent": "question", "snapshot_id": contract["snapshot_id"], "plan": plan, "rows": rows,
           "total_count": meas(sc[m]), "total_base": meas(sc)}, open("/out/result.json", "w"))
'''

# Program B: the standard library only (the containment follow-up fixture is exactly that).
STDLIB_PROGRAM = (TASKS / "followup.py").read_text()

# A plausible bug: counts every group's base one too high.
OFF_BY_ONE_PROGRAM = STDLIB_PROGRAM.replace('rows = [{"id": g, "count": size(count[g]), "base": size(base[g])} for g in groups]',
                                            'rows = [{"id": g, "count": size(count[g]), "base": size(base[g]) + 1} for g in groups]')
assert OFF_BY_ONE_PROGRAM != STDLIB_PROGRAM


def run_locally(code: str, files: dict[str, str]) -> tuple[int, str | None, str]:
    """(exit code, result.json text or None, stderr)."""
    with tempfile.TemporaryDirectory() as d:
        d_in, d_out = Path(d, "in"), Path(d, "out")
        d_in.mkdir()
        d_out.mkdir()
        for k, v in files.items():
            (d_in / k).write_text(v)
        src = code.replace("/in/", f"{d_in}/").replace("/out/", f"{d_out}/")
        p = subprocess.run([sys.executable, "-c", src], capture_output=True, text=True, timeout=60, env=dict(os.environ))
        out = d_out / "result.json"
        return p.returncode, out.read_text() if out.exists() else None, p.stderr[-2000:]


def job(state="succeeded", output=None, stderr="", error=None, elapsed=1234, timed_out=False, exit_code=None):
    return JobResult({"job_id": str(uuid.uuid4()), "kind": "analysis", "state": state,
                      "exit_code": exit_code if exit_code is not None else (0 if state == "succeeded" else 1),
                      "started_at": "2026-09-27T00:00:00.000Z", "finished_at": "2026-09-27T00:00:01.234Z",
                      "elapsed_ms": elapsed, "timed_out": timed_out, "container_removed": True, "runtime": "runsc",
                      "image": "logless-analysis:1@sha256:" + "ab" * 32, "output": output, "output_bytes": len(output or ""),
                      "stderr_tail": stderr, "error": error, "host": "logless-sandbox", "code_sha256": "0" * 64,
                      "limits": {"cpus": 1, "memory_mb": 512, "pids": 64, "timeout_s": 10.0, "network": "none", "read_only_root": True}})


class LocalRunner:
    """Executes submitted programs on this machine (runaway fixtures are reported as killed)."""

    def __init__(self):
        self.calls: list[dict] = []

    def run(self, *, kind, code, files, timeout_s, memory_mb=512):
        self.calls.append({"kind": kind, "code": code, "files": files, "timeout_s": timeout_s})
        if "while True" in code:
            return job(state="timed_out", error="timeout", timed_out=True, elapsed=int(timeout_s * 1000) + 60, exit_code=137)
        if "no-preserve-root" in code:
            # NEVER run the destructive fixture on the test host: it targets "/", not a temp dir.
            # In the real sandbox the read-only root absorbs it; here, stand in for that outcome.
            import json as _json
            return job(output=_json.dumps({"command": "rm -rf --no-preserve-root /", "ran": True, "rm_exit_code": 1,
                                          "refused": 11089, "root_writable": False, "python_present": True}))
        rc, out, err = run_locally(code, files)
        if rc != 0:
            return job(state="failed", error="nonzero_exit", stderr=err, exit_code=rc)
        if out is None:
            return job(state="failed", error="no_output")
        return job(output=out)
