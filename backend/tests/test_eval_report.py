import json

from logless import db
from logless.eval import report


def _run(con, run_id, kind, intent, snap, state="completed", passed=True, error=None):
    body = {"run_id": run_id, "kind": kind, "intent": intent, "snapshot_id": snap, "state": state, "attempts": 1,
            "verdict": {"passed": passed, "checks": [{"name": "schema", "passed": passed, "detail": ""}]},
            "error": error,
            "containment": {"killed": True, "container_removed": True, "app_health": "ok", "followup_passed": True,
                            "leak_attempt_rejected": True,
                            "destructive": {"contained": True, "container_removed": True, "next_run_clean": True}}
                           if kind == "containment" else None}
    con.execute("INSERT INTO runs(run_id, kind, intent, snapshot_id, state, json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (run_id, kind, intent, snap, state, json.dumps(body), "2026-09-27T00:00:00Z", "2026-09-27T00:00:00Z"))


def test_run_checks_scoped_to_snapshot_and_pending_counts_as_not_verified(tmp_data):
    con = db.public()
    _run(con, "run_000000000001", "containment", None, "snap_OTHER")
    _run(con, "run_000000000002", "analysis", "question", "snap_OTHER")
    _run(con, "run_000000000003", "analysis", "question", "snap_THIS", state="failed", passed=False,
         error={"code": "unsupported_question", "message": "x"})
    con.commit()
    checks = {c["id"]: c for c in report.sandbox_checks("snap_THIS")}
    # runs of another snapshot don't count; missing mandatory runs are "not yet verified" and fail
    assert checks["containment"]["passed"] is False and checks["containment"]["value"] == report.NOT_VERIFIED
    # a refusal alone is correct behaviour but does not verify that questions get answered
    assert checks["live_question"]["passed"] is False and "1 refused" in checks["live_question"]["value"]
    ok = {c["id"]: c for c in report.sandbox_checks("snap_OTHER")}
    assert ok["containment"]["passed"] is True and ok["live_question"]["passed"] is True
    assert set(ok) == {"containment", "live_question"}


def test_no_question_runs_is_not_verified(tmp_data):
    checks = {c["id"]: c for c in report.sandbox_checks("snap_NONE")}
    assert checks["live_question"]["passed"] is False and checks["live_question"]["value"] == report.NOT_VERIFIED


def test_check_details_fit_the_api_limits():
    c = report.check("x", "n", "v", "t", None, "d" * 900)
    assert len(c["detail"]) <= 600


def test_containment_requires_all_claimed_safety_checks(tmp_data):
    con = db.public()
    _run(con, "run_000000000001", "containment", None, "snap_THIS")
    row = con.execute("SELECT json FROM runs").fetchone()
    data = json.loads(row["json"])
    data["containment"]["leak_attempt_rejected"] = False
    con.execute("UPDATE runs SET json = ?", (json.dumps(data),))
    con.commit()
    checks = {c["id"]: c for c in report.sandbox_checks("snap_THIS")}
    assert checks["containment"]["passed"] is False


def test_friction_reference_excludes_out_of_scope_stored_predictions(tmp_data, tmp_path, monkeypatch):
    gold = tmp_path / "gold"
    gold.mkdir()
    rows = []
    for labeller in ("model-a", "model-b"):
        rows.append({"conv_id": "outside", "labeller": labeller, "friction": {s: "observed" for s in report.SIGNALS}})
    (gold / "friction_sample.jsonl").write_text("\n".join(json.dumps(row) for row in rows))
    monkeypatch.setattr(report, "GOLD_DIR", gold)
    called = []
    def predictions(ids, column="choice"):
        called.extend(ids)
        return {"outside": {s: "observed" for s in report.SIGNALS}}
    monkeypatch.setattr(report, "jev_friction", predictions)
    checks = report.friction_reference({"inside"})
    assert "outside" not in called
    assert all(c["value"] == report.NOT_VERIFIED for c in checks)


def test_reconciliation_uses_frozen_inputs_after_mutable_decisions_change(tmp_data, monkeypatch):
    from logless.pipeline import publish, stats
    from logless.sandbox.export import save_cluster_map
    from tests.test_publish import _fake_build
    build = _fake_build(tmp_data, monkeypatch)
    monkeypatch.setattr(stats, "save_cluster_map", save_cluster_map)
    stats.run(build)
    publish.run(build)
    snapshot = report.current_snapshot()
    with db.write(db.private()):
        db.private().execute("UPDATE friction SET choice = 'observed'")
        db.private().execute("DELETE FROM assignments")
    checks = {check["id"]: check for check in report.reconciliation(snapshot, build)}
    assert checks["metric_reconciliation"]["passed"] is True
    frozen = report.snapshot_rows(snapshot["snapshot_id"])[0]
    assert sum(r["correction"] == "observed" for r in frozen) == 2


def test_missing_frozen_inputs_do_not_fall_back_to_current_assignments(tmp_data, monkeypatch):
    from logless.pipeline import publish, stats
    from tests.test_publish import _fake_build
    build = _fake_build(tmp_data, monkeypatch)
    stats.run(build)
    publish.run(build)
    checks = report.reconciliation(report.current_snapshot(), build)
    assert checks[0]["passed"] is False and checks[0]["value"] == report.NOT_VERIFIED


def test_no_canaries_is_unverified_not_a_success(tmp_data):
    checks, _ = report.leak_checks([])
    canary = next(c for c in checks if c["id"] == "canary_leaks")
    assert canary["passed"] is False and canary["value"] == report.NOT_VERIFIED


def test_evaluation_never_regenerates_missing_embeddings(tmp_data, monkeypatch):
    from logless.pipeline import util
    def unexpected(*args):
        raise AssertionError("evaluation must not make model calls")
    monkeypatch.setattr("logless.pipeline.discover.load_embeddings", unexpected)
    checks = report.cluster_quality({"clusters": [], "provenance": {"discovery_rounds": 1}},
                                    util.Build("b_test", None, [], "now"))
    silhouette = next(c for c in checks if c["id"] == "silhouette")
    assert silhouette["value"] == "unavailable" and silhouette["detail"] == "FileNotFoundError"
