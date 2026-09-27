"""Pipeline stage 5: snapshot aggregation in the sandbox, gated against the trusted reference.

    run_aggregate(build_id, clusters, snapshot_id) -> {"metrics", "totals", "total_conversations", "receipt", "verdict"}

`metrics` maps every category and leaf id (plus "total") to Metrics-without-languages, with shares
rounded to 4 decimals exactly like `pipeline.stats.reference_metrics`.

`clusters` is the pipeline's mapping [{id, parent_id, level, is_other, theme_ids}] (categories are
level 1, leaves level 2, the catch-all leaf has is_other=True and should list theme id "other").
The version-controlled task `backend/sandbox_tasks/aggregate.py` runs in the sandbox on the typed,
text-free inputs; its output must pass the egress gate, and the returned metrics are the
reference values (shares rounded to 4 decimals), never the sandbox bytes.

Raises SandboxUnavailable if the runner cannot be reached (the pipeline decides what to do) and
AggregateRejected if the job fails or its result does not pass the gate."""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from . import gate, reference
from .client import RunnerClient, SandboxUnavailable, receipt
from .export import export_inputs, save_cluster_map

log = logging.getLogger("logless.sandbox")
TASKS_DIR = Path(__file__).resolve().parents[2] / "sandbox_tasks"
AGGREGATE_TIMEOUT_S = 10.0

__all__ = ["run_aggregate", "AggregateRejected", "SandboxUnavailable", "task_source"]


class AggregateRejected(RuntimeError):
    def __init__(self, message: str, verdict: dict | None, receipt: dict | None):
        super().__init__(message)
        self.verdict, self.receipt = verdict, receipt


def task_source(name: str) -> str:
    return (TASKS_DIR / name).read_text()


def contract(intent: str, snapshot_id: str) -> dict:
    from .analysis import output_contract  # shared contract text
    return output_contract(intent, snapshot_id)


def run_aggregate(build_id: str, clusters: list[dict], snapshot_id: str, *, runner: RunnerClient | None = None) -> dict:
    inputs = export_inputs(build_id, clusters)
    ref = reference.aggregate(inputs.df, inputs.clusters, snapshot_id)
    code = task_source("aggregate.py")
    code_sha = hashlib.sha256(code.encode()).hexdigest()
    runner = runner or RunnerClient()
    res = runner.run(kind="aggregate", code=code, files=inputs.files(contract("aggregate", snapshot_id)), timeout_s=AGGREGATE_TIMEOUT_S)
    rc = receipt(res, code_sha, timeout_s=AGGREGATE_TIMEOUT_S)
    if res.state != "succeeded":
        raise AggregateRejected(f"aggregate job {res.state} ({res.get('error')})", None, rc)
    verdict = gate.check(res.output, intent="aggregate", snapshot_id=snapshot_id, leaf_ids=inputs.leaf_ids,
                         category_ids=inputs.category_ids, reference=ref)
    if not verdict.passed:
        raise AggregateRejected("aggregate result rejected by the egress gate: " + ", ".join(verdict.failed_names),
                                verdict.public(), rc)
    # Live analyses on this snapshot rebuild inputs from the same private theme -> leaf mapping.
    save_cluster_map(snapshot_id, build_id, clusters)
    canon = verdict.canonical or {}
    metrics = {n["id"]: {k: v for k, v in n.items() if k != "id"} for n in canon["nodes"]}
    metrics["total"] = canon["totals"]
    log.info("aggregate passed the gate: %d nodes, %d conversations, %d ms", len(metrics), canon["total_conversations"], rc["elapsed_ms"])
    return {"metrics": metrics, "totals": canon["totals"], "total_conversations": canon["total_conversations"],
            "receipt": rc, "verdict": verdict.public()}
