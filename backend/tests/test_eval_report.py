import json

from logless import db
from logless.eval import report


def _run(con, run_id, kind, intent, snap, state="completed", passed=True):
    body = {"run_id": run_id, "kind": kind, "intent": intent, "snapshot_id": snap, "state": state, "attempts": 1,
            "verdict": {"passed": passed, "checks": [{"name": "schema", "passed": passed, "detail": ""}]},
            "containment": {"killed": True, "container_removed": True, "app_health": "ok"} if kind == "containment" else None}
    con.execute("INSERT INTO runs(run_id, kind, intent, snapshot_id, state, json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (run_id, kind, intent, snap, state, json.dumps(body), "2026-09-27T00:00:00Z", "2026-09-27T00:00:00Z"))


def test_sandbox_checks_scoped_to_snapshot_and_pending_counts_as_not_verified(tmp_data):
    con = db.public()
    _run(con, "run_000000000001", "containment", None, "snap_OTHER")
    _run(con, "run_000000000002", "analysis", "usage", "snap_OTHER")
    _run(con, "run_000000000003", "analysis", "friction", "snap_THIS", state="failed", passed=False)
    con.commit()
    checks = {c["id"]: c for c in report.sandbox_checks("snap_THIS")}
    # runs of another snapshot don't count; missing mandatory runs are "not yet verified" and fail
    assert checks["containment"]["passed"] is False and checks["containment"]["value"] == report.NOT_VERIFIED
    assert checks["live_usage"]["passed"] is False and checks["live_usage"]["value"] == report.NOT_VERIFIED
    assert checks["live_friction"]["passed"] is False and checks["live_friction"]["value"] == "failed"
    ok = {c["id"]: c for c in report.sandbox_checks("snap_OTHER")}
    assert ok["containment"]["passed"] is True and ok["live_usage"]["passed"] is True


def test_check_details_fit_the_api_limits():
    c = report.check("x", "n", "v", "t", None, "d" * 900)
    assert len(c["detail"]) <= 600
