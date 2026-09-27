"""The containment demonstration (POST /api/demo/containment). Accepts no code: every program is a
fixed, version-controlled fixture from backend/sandbox_tasks/.

  runaway      — an infinite loop with a 2.0 s deadline, killed from outside by the supervisor
  cleanup      — the runner verified that no container with the job's label is left
  health       — the API's own health logic still reports ok
  followup     — a fixed benign stdlib program answers a fixed plan and passes the gate, including
                 the consistency checks against the published snapshot
  leak_attempt — a program that tries to publish per-user friction rows; the gate must reject it

Every flag in the `containment` object is set only from observed evidence: `killed` from a
timed-out job, `container_removed` from the runner's verified removal, `followup_passed` from a
passing gate verdict, `leak_attempt_rejected` only from an actual gate rejection of output the
leak program produced. If any expected property is not observed, the run ends `failed` with a
fixed error code and the flags show exactly what was (not) observed.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Callable

from pathlib import Path

from . import gate
from .analysis import load_inputs, output_contract
from .client import RunnerClient, SandboxInvalidResponse, SandboxUnavailable, receipt
from .export import SandboxInputs
from .runs import Run

log = logging.getLogger("logless.sandbox")
RUNAWAY_DEADLINE_S = 2.0
FOLLOWUP_TIMEOUT_S = 10.0
TASKS_DIR = Path(__file__).resolve().parents[2] / "sandbox_tasks"
# The fixed plan the follow-up and leak programs are checked against: conversations per category.
FIXED_PLAN = {"group_by": "category", "scope_category_id": None, "measure": "conversations", "signal": None,
              "rank_by": "count", "limit": 5}


def task_source(name: str) -> str:
    return (TASKS_DIR / name).read_text()

FAILURES = {
    "killed": "the runaway job was not killed at its deadline",
    "container_removed": "the runaway job's container was not verified as removed",
    "app_health": "the API did not report healthy",
    "followup_passed": "the follow-up run did not pass the egress gate",
    "leak_attempt_rejected": "the gate did not reject the leak attempt",
}


def _sha(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def run_containment(run: Run, *, snapshot_id: str, health: Callable[[], str], nodes: dict[str, dict],
                    runner: RunnerClient | None = None, inputs: SandboxInputs | None = None) -> None:
    """`nodes` maps published ids to snapshot nodes (for the follow-up's consistency checks)."""
    try:
        _run(run, snapshot_id, health, nodes, runner or RunnerClient(), inputs)
    except SandboxInvalidResponse:
        run.fail("sandbox_invalid_response", "The sandbox returned a malformed response, so nothing from it was used.")
    except SandboxUnavailable:
        run.fail("sandbox_unavailable", "The sandbox is unreachable right now; the saved snapshot is unaffected.")
    except Exception as e:  # noqa: BLE001
        log.error("containment %s crashed: %s", run.id, type(e).__name__)
        run.fail("internal_error", "The containment check failed unexpectedly.")


def _run(run: Run, snapshot_id: str, health: Callable[[], str], nodes: dict[str, dict], runner: RunnerClient,
         inputs: SandboxInputs | None) -> None:
    # `containment` is only filled in when the run ends; until then the named stages drive the
    # UI's live checklist. Every flag starts False and flips only on observed evidence.
    c = {"deadline_ms": int(RUNAWAY_DEADLINE_S * 1000), "elapsed_ms": 0, "killed": False, "container_removed": False,
         "app_health": "degraded", "followup_passed": False, "leak_attempt_rejected": False, "leak_rejection_checks": []}

    # 1. runaway job, killed from outside at the deadline
    run.state("executing")
    run.stage("runaway", "running", "infinite loop · 2.0 s deadline enforced by the supervisor outside the container")
    code = task_source("runaway.py")
    res = runner.run(kind="containment", code=code, files={}, timeout_s=RUNAWAY_DEADLINE_S)
    rc = receipt(res, _sha(code), timeout_s=RUNAWAY_DEADLINE_S)
    c.update(elapsed_ms=rc["elapsed_ms"], killed=res.state == "timed_out" and bool(res.get("timed_out")),
             container_removed=bool(res.get("container_removed")))
    run.update(receipt=rc, attempts=1)
    if c["killed"]:
        run.stage("runaway", "done", f"Execution limit reached · sandbox terminated after {rc['elapsed_ms']:,} ms "
                                     f"(deadline {c['deadline_ms']:,} ms)")
    else:
        run.stage("runaway", "failed", f"the job was not killed at the deadline (job {res.state})")

    # 2. cleanup: the runner verified with `docker ps -a --filter label=logless.job=<id>`
    run.stage("cleanup", "running")
    run.stage("cleanup", "done" if c["container_removed"] else "failed",
              "container removed; no container left with its job label" if c["container_removed"]
              else "container removal could NOT be verified")

    # 3. app health, right after the runaway was handled
    run.stage("health", "running")
    c["app_health"] = "ok" if health() == "ok" else "degraded"
    run.stage("health", "done" if c["app_health"] == "ok" else "failed", f"API health: {c['app_health']}")

    # 4 + 5 need the typed inputs of the current snapshot
    try:
        inputs = inputs or load_inputs(snapshot_id)
    except LookupError:
        run.stage("followup", "skipped", "no sandbox inputs for this snapshot")
        run.stage("leak_attempt", "skipped", "no sandbox inputs for this snapshot")
        run.update(containment=c)
        run.fail("no_inputs", "This snapshot has no sandbox inputs, so the follow-up and leak checks could not run.")
        return

    run.stage("followup", "running", "fixed benign stdlib program in a fresh container")
    files = inputs.files(output_contract(snapshot_id, FIXED_PLAN))
    code = task_source("followup.py")
    res = runner.run(kind="analysis", code=code, files=files, timeout_s=FOLLOWUP_TIMEOUT_S)
    run.update(attempts=2)
    if res.state == "succeeded":
        v = gate.check_program(res.output, snapshot_id=snapshot_id, plan=FIXED_PLAN, clusters=inputs.clusters,
                               leaf_ids=inputs.leaf_ids, category_ids=inputs.category_ids)
        snap = gate.check_snapshot(v.canonical, plan=FIXED_PLAN, clusters=inputs.clusters, nodes=nodes) if v.passed else []
        checks = v.checks + snap
        c["followup_passed"] = v.passed and all(x.passed for x in snap)
        run.stage("followup", "done" if c["followup_passed"] else "failed",
                  f"exit 0 in {int(res.get('elapsed_ms') or 0):,} ms · gate {'passed' if c['followup_passed'] else 'rejected'} "
                  f"{sum(x.passed for x in checks)}/{len(checks)} checks, incl. consistency with the published snapshot")
    else:
        run.stage("followup", "failed", f"the follow-up job did not complete (job {res.state})")

    run.state("validating")
    run.stage("leak_attempt", "running", "a program tries to publish per-user friction rows")
    code = task_source("leak_attempt.py")
    res = runner.run(kind="analysis", code=code, files=files, timeout_s=FOLLOWUP_TIMEOUT_S)
    run.update(attempts=3)
    if res.state != "succeeded":
        # No output means the gate was never exercised: that is not a rejection, and not a pass.
        run.stage("leak_attempt", "failed", f"the leak-attempt program did not run to completion (job {res.state}); "
                                            "the gate was not exercised")
        run.update(containment=c)
        run.fail("leak_fixture_failed", "The leak-attempt program did not run to completion, so the egress gate "
                                        "was not exercised. Run the check again.")
        return
    v = gate.check_program(res.output, snapshot_id=snapshot_id, plan=FIXED_PLAN, clusters=inputs.clusters,
                           leaf_ids=inputs.leaf_ids, category_ids=inputs.category_ids)
    c["leak_attempt_rejected"] = not v.passed
    c["leak_rejection_checks"] = v.failed_names
    run.update(verdict=v.public())
    run.stage("leak_attempt", "done" if not v.passed else "failed",
              ("gate rejected the per-user rows: " + ", ".join(v.failed_names)) if not v.passed
              else "the gate did NOT reject the output")
    run.update(containment=c)

    missing = [msg for key, msg in FAILURES.items() if (c[key] != "ok" if key == "app_health" else not c[key])]
    if missing:
        run.fail("containment_check_failed", "Not observed: " + "; ".join(missing) + ".")
        return
    run.complete()
