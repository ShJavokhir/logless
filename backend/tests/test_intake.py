import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from logless import db, intake
from logless.pipeline import publish, stats
from tests.test_publish import _fake_build

SIG = ("correction", "repeat_request", "assistant_limit", "complaint")
BATCH = "ib_20260927T000000"
TASKS = [
    "Write a polite email asking a landlord to repair a heater",                # -> Write emails
    "Fix a KeyError in a Python script that reads a dictionary",                # -> Fix code
    "Draft an essay about the causes of the First World War for a class",      # -> Write essays
    "Contact me at someone@example.com to write an email for a job offer",      # email in facet -> summary withheld
    "Something vague",                                                         # low confidence -> cl_other
    "Fix a CSS layout bug on a web page " + "with many nested flexbox containers " * 3,  # long summary, cut to 90
]


def _choice(name, p, others):
    probs = {o: (1 - p) / max(1, len(others) - 1) for o in others if o != name}
    probs[name] = p
    return {"type": "choice", "choice": name, "probabilities": probs}


def fake_ask(state, questions):
    """Deterministic stand-in for Jev: routes on words in the facet task."""
    task = state["facets"]["task"].lower()
    opts = list(questions["theme"]["criteria"])
    if "email" in task:
        theme = _choice("Write emails", 0.9, opts)
    elif "fix" in task:
        theme = _choice("Fix code", 0.95, opts)
    elif "essay" in task:
        theme = _choice("Write essays", 0.8, opts)
    else:
        theme = _choice("Write essays", 0.4, opts)  # below the 0.65 cutoff -> cl_other
    tri = ["observed", "not_observed", "unclear"]
    ans = {"theme": theme}
    for s in SIG:
        obs = s == "correction" and "fix" in task
        ans[s] = _choice("observed" if obs else "not_observed", 0.9, tri)
    return ans


def _setup(tmp_data, monkeypatch):
    b = _fake_build(tmp_data, monkeypatch)
    monkeypatch.setattr("logless.pipeline.stats.save_cluster_map", lambda *a, **k: None)
    con = db.private()
    b.save("scope", b.conv_ids)
    b.save("build", {"build_id": b.build_id, "limit": b.limit, "started_at": b.started_at, "info": b.info, "usage": []})
    stats.run(b)
    publish.run(b)
    base = con.execute("SELECT 1").fetchone() and db.public().execute("SELECT snapshot_id FROM snapshots WHERE is_current=1").fetchone()[0]
    con.execute("INSERT INTO builds(build_id, started_at, status, stages_json, snapshot_id) VALUES (?,?,?,?,?)",
                (b.build_id, b.started_at, "published", json.dumps(b.stages), base))
    intake.ensure_schema()
    from logless.pipeline import facets
    facets.ensure_schema()
    ids = []
    for i, task in enumerate(TASKS):
        cid = f"c_{0xabc000 + i:012x}"
        ids.append(cid)
        con.execute("INSERT INTO conversations(conv_id, turn_identifier, user_id, language, turns, ts, text, is_fixture, intake_batch)"
                    " VALUES (?,?,?,?,?,?,?,0,?)", (cid, 5000 + i, f"u_batch{i}", "English", 2,
                                                   "2023-04-20T00:00:00+00:00", f"user: {task}\nassistant: ok", BATCH))
        con.execute("INSERT INTO facets(conv_id, user_goal, task, domain, language, facet_text, prompt_version)"
                    " VALUES (?,?,?,?,?,?,?)", (cid, "Get help", task, "misc", "English", task, "fa1+pii1"))
        con.execute("INSERT INTO facet_checks(conv_id, pii_p, rewritten, status) VALUES (?,?,?,?)",
                    (cid, 0.1, 0, "ok"))
    con.execute("INSERT INTO intake_batches(batch_id, created_at, n, seed, status, base_snapshot_id, base_build_id)"
                " VALUES (?,?,?,?,?,?,?)", (BATCH, "2026-09-27T00:00:00Z", len(ids), 1, "ready", base, b.build_id))
    con.commit()
    monkeypatch.setattr(intake, "ASK", fake_ask)
    return b, base, ids


def _run(base, n):
    run = intake.IntakeRun(base, n)
    result = intake.run_batch(run, evaluate=lambda s: None)
    return run, result


def test_engine_with_fake_jev(tmp_data, monkeypatch):
    b, base, ids = _setup(tmp_data, monkeypatch)
    assert intake.status()["ready"] is True
    base_snap = intake.snapshot_json(base)
    run, res = _run(base, len(ids))
    page = run.page(0)
    assert page["state"] == "completed" and page["counters"]["total"] == len(ids) == page["counters"]["decided"]
    assert page["counters"]["decisions_per_conversation"] == 5 and page["counters"]["per_second"] > 0
    evs = page["events"]
    assert [e["seq"] for e in evs] == list(range(1, len(ids) + 1))
    assert all(set(e) == {"seq", "t_ms", "leaf_id", "p", "friction", "language", "turns", "summary"} for e in evs)
    dump = json.dumps(page)
    assert not any(c in dump for c in ids) and "u_batch" not in dump and "assistant: ok" not in dump
    by_summary = {e["summary"]: e for e in evs}
    assert None in by_summary                                # the email facet's summary is withheld
    assert all(s is None or len(s) <= 90 for s in by_summary)
    assert any(s and s.endswith("…") for s in by_summary)    # the long one is cut at a word boundary
    assert sum(1 for e in evs if e["leaf_id"] == "cl_other") == 1
    # the new snapshot is live and consistent: leaf sums = base + batch; categories are unions
    new = intake.current_snapshot()
    assert new["snapshot_id"] == res["published_snapshot_id"] != base
    assert new["totals"]["conversations"] == base_snap["totals"]["conversations"] + len(ids)
    assert sum(l["conversations"] for l in new["clusters"]) == new["totals"]["conversations"]
    for c in new["categories"]:
        assert c["conversations"] == sum(l["conversations"] for l in new["clusters"] if l["parent_id"] == c["id"])
    assert {l["id"]: l["title"] for l in new["clusters"]} == {l["id"]: l["title"] for l in base_snap["clusters"]}
    assert "ingested by live intake" in new["dataset"]["sample_note"]
    assert res["batch_size"] == len(ids) and res["other"] == 1 and res["base_snapshot_id"] == base
    assert 1 <= len(res["deltas"]) <= 8 and all(d["conversations_after"] >= d["conversations_before"] for d in res["deltas"])
    assert publish.validate(new, strict_ranges=False) == []
    # the eval / later stages resolve the intake snapshot to its base build
    assert intake.build_of_snapshot(new["snapshot_id"]) == b.build_id
    # a second run is refused until reset
    assert intake.status()["ready"] is False


def test_events_pagination(tmp_data):
    run = intake.IntakeRun("snap_20260927T000000_abcd", 450)
    run.t0 = 0.0
    for i in range(450):
        run.add_event({"leaf_id": "cl_other", "p": 0.5, "friction": {}, "language": "English", "turns": 1, "summary": None}, 0.2)
    p1 = run.page(0)
    assert len(p1["events"]) == 200 and p1["events"][-1]["seq"] == 200
    p2 = run.page(200)
    assert [e["seq"] for e in p2["events"]][:1] == [201] and len(p2["events"]) == 200
    assert len(run.page(400)["events"]) == 50 and run.page(450)["events"] == []
    assert run.page(0)["counters"]["p50_ms"] == 200


def test_reset_restores_base_and_is_idempotent(tmp_data, monkeypatch):
    b, base, ids = _setup(tmp_data, monkeypatch)
    _run(base, len(ids))
    assert intake.current_snapshot()["snapshot_id"] != base
    out = intake.reset()
    assert out["restored_base"] is True and intake.current_snapshot()["snapshot_id"] == base
    con = db.private()
    q = ",".join("?" * len(ids))
    assert con.execute(f"SELECT COUNT(*) FROM assignments WHERE conv_id IN ({q})", ids).fetchone()[0] == 0
    assert con.execute(f"SELECT COUNT(*) FROM friction WHERE conv_id IN ({q})", ids).fetchone()[0] == 0
    assert intake.status()["ready"] is True
    again = intake.reset()
    assert again["restored_base"] is False and intake.current_snapshot()["snapshot_id"] == base
    # the run can be repeated after a reset
    run, res = _run(base, len(ids))
    assert run.page(0)["state"] == "completed" and res["base_snapshot_id"] == base


def test_scope_excludes_intake_rows(tmp_data, monkeypatch):
    b, base, ids = _setup(tmp_data, monkeypatch)
    from logless.pipeline.run import scope
    s = scope(None)
    assert not set(ids) & set(s) and set(b.conv_ids) <= set(s)


def test_summary_withholding():
    assert intake.summary_for("Write a cover letter for a retail job", "ok") == "Write a cover letter for a retail job"
    assert intake.summary_for("Email me at someone@example.com about the report", "ok") is None
    assert intake.summary_for("Visit https://example.org for details", "ok") is None
    assert intake.summary_for("Write a cover letter", "fallback") is None      # did not pass the PII check
    assert intake.summary_for(None, "ok") is None
    long = intake.summary_for("Explain " + "very " * 40 + "long things", "ok")
    assert len(long) <= 90 and long.endswith("…")


def test_presenter_enforcement(tmp_data, monkeypatch):
    from logless.api import intake as api_intake
    app = FastAPI()
    app.include_router(api_intake.router)
    c = TestClient(app)
    monkeypatch.setenv("PRESENTER_KEY", "k" * 32)
    assert c.post("/api/intake/runs", json={}).status_code == 403
    assert c.post("/api/intake/runs", json={}, headers={"X-Logless-Presenter": "wrong"}).json()["code"] == "presenter_required"
    assert c.post("/api/intake/reset", json={}).status_code == 403
    r = c.post("/api/intake/runs", json={}, headers={"X-Logless-Presenter": "k" * 32})
    assert r.status_code == 409 and r.json()["code"] == "intake_not_ready"
    assert c.get("/api/intake/status").json() == {"ready": False, "batch_size": 0, "base_snapshot_id": None}
    assert c.get("/api/intake/runs/run_000000000000/events").status_code == 404


def test_api_run_end_to_end(tmp_data, monkeypatch):
    b, base, ids = _setup(tmp_data, monkeypatch)
    monkeypatch.setattr(intake, "_default_evaluate", lambda s: None)
    from logless.api import intake as api_intake
    app = FastAPI()
    app.include_router(api_intake.router)
    c = TestClient(app)
    monkeypatch.setenv("PRESENTER_KEY", "k" * 32)
    h = {"X-Logless-Presenter": "k" * 32}
    assert c.get("/api/intake/status").json()["ready"] is True
    rid = c.post("/api/intake/runs", json={}, headers=h).json()["run_id"]
    import time
    for _ in range(200):
        page = c.get(f"/api/intake/runs/{rid}/events", params={"after": 0}).json()
        if page["state"] != "running":
            break
        time.sleep(0.05)
    assert page["state"] == "completed" and len(page["events"]) == len(ids)
    assert page["intake"]["published_snapshot_id"] == intake.current_snapshot()["snapshot_id"]
    row = db.public().execute("SELECT kind, state FROM runs WHERE run_id = ?", (rid,)).fetchone()
    assert tuple(row) == ("intake", "completed")
    assert c.post("/api/intake/reset", json={}, headers=h).json()["snapshot_id"] == base
