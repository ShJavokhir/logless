import json
import re

import httpx
import pytest

from logless import db, intake
from logless.pipeline import gate, prompts, run as runmod, util
from logless.providers import http
from logless.providers.http import ProviderError
from tests.test_publish import _fake_build

BILLING = ProviderError("jev", 402, "billing_error")


# ---------------------------------------------------------------- provider layer

def test_402_is_fatal_not_retried_and_surfaced(tmp_data, monkeypatch):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(402, json={"error": {"message": "no available TypeSafe API credits"}})

    monkeypatch.setattr(http, "_client", httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(ProviderError) as e:
        http.post_json("jev", "https://example.invalid/x", "k", {})
    assert len(calls) == 1
    assert e.value.status == 402 and e.value.code == "billing_error" and e.value.fatal
    assert e.value.describe() == "jev unavailable: billing_error"


def test_pmap_fails_fast_on_consecutive_fatal_errors():
    attempted = []

    def fn(x):
        attempted.append(x)
        raise BILLING

    with pytest.raises(util.ProviderUnavailable) as e:
        util.pmap(fn, list(range(200)), 4, "t")
    assert str(e.value) == "jev unavailable: billing_error"
    assert len(attempted) < 40  # stopped early instead of burning through all 200


def test_pmap_tolerates_sporadic_errors():
    def fn(x):
        if x % 7 == 0:
            raise ProviderError("jev", 503, "overloaded")
        return x

    out, errs = util.pmap(fn, list(range(50)), 4, "t")
    assert errs == 8 and out[1] == 1


# ---------------------------------------------------------------- gate roll-up chains

def test_rollup_follows_chains_without_stopiteration(tmp_data, monkeypatch):
    import numpy as np
    b = _fake_build(tmp_data, monkeypatch)
    st = b.load("structure_final")
    for lid in ("cl_444444", "cl_555555", "cl_666666", "cl_777777"):  # more leaves so 2 roll-ups stay under the cap
        st["leaves"].insert(0, {**st["leaves"][0], "id": lid, "theme_ids": [f"t_{lid}"]})
    ids = [lf["id"] for lf in st["leaves"]]
    vecs = {lid: np.eye(8)[i] for i, lid in enumerate(ids)}
    vecs["cl_111111"] = np.array([0.0, 0, 0, 0, 0, 1, 1, 0]) / np.sqrt(2)   # 111111 ~ 222222
    vecs["cl_222222"] = np.array([0.0, 0, 0, 0, 0, 1, 0.9, 0]) / np.sqrt(1.81)
    monkeypatch.setattr(gate, "leaf_members", lambda build, leaves: {lf["id"]: [] for lf in leaves})
    monkeypatch.setattr(gate, "leaf_centroids", lambda build, members: vecs)
    # 111111 rolls into 222222, then 222222 itself rolls up: the chain must resolve, not raise
    out = gate.rollup(b, st, ["cl_111111", "cl_222222"])
    assert [r["leaf"] for r in out] == ["cl_111111", "cl_222222"]
    alive = {lf["id"] for lf in st["leaves"]}
    assert "cl_111111" not in alive and "cl_222222" not in alive
    assert all(r["into"] in alive for r in out)


def test_rollup_refuses_mass_rollup(tmp_data, monkeypatch):
    b = _fake_build(tmp_data, monkeypatch)
    st = b.load("structure_final")
    with pytest.raises(RuntimeError, match="refusing"):
        gate.rollup(b, st, ["cl_111111", "cl_222222", "cl_333333"])


# ---------------------------------------------------------------- resume: gate fails on 402, then resumes

def _fake_glm(system, user, schema, **kw):
    if schema is prompts.Audit:
        keys = re.findall(r'"key": "([^"]+)"', user)
        return prompts.Audit(items=[prompts.AuditItem(key=k, verdict="pass") for k in keys])
    if schema is prompts.ShortLabels:
        doc = json.loads(user.split("\n", 1)[1])
        return prompts.ShortLabels(items=[{"key": n["key"], "short_title": "Node " + chr(65 + i)}
                                          for i, n in enumerate(doc["nodes"])])
    if schema is prompts.Rewrites:
        return prompts.Rewrites(items=[])
    raise AssertionError(f"unexpected GLM schema {schema.__name__}")


def _fake_jev(state, questions):
    out = {}
    for k, q in questions.items():
        if q["type"] == "score":
            out[k] = {"type": "score", "score": 0.1, "probabilities": {"0": 0.9, "1": 0.1, "2": 0, "3": 0}}
        else:
            opts = list(q["criteria"])
            out[k] = {"type": "choice", "choice": opts[0], "probabilities": {o: (0.9 if i == 0 else 0.1 / (len(opts) - 1))
                                                                               for i, o in enumerate(opts)}}
    return out


def _described_build(tmp_data, monkeypatch):
    b = _fake_build(tmp_data, monkeypatch)
    monkeypatch.setattr("logless.pipeline.stats.save_cluster_map", lambda *a, **k: None)
    st = b.load("structure_final")
    for c in st["categories"]:
        c["title"], c["description"] = c["title_pub"], c["description_pub"]
    b.save("structure_described", st)
    b.save("describe_private", {"leaves": {lf["id"]: {"records": b.conv_ids[:2], "notes": {}} for lf in st["leaves"]},
                                "dominated": []})
    b.save("evidence", {lf["id"]: {"n1": b.conv_ids[:1], "p1": b.conv_ids[:1]} for lf in st["leaves"]})
    b.save("scope", b.conv_ids)
    stages = [{"stage": s, "started_at": "x", "finished_at": "y", "counts": {"n": 1}, "models": []}
              for s in ("facets", "discover", "classify", "leftovers", "hierarchy", "describe")]
    b.save("build", {"build_id": b.build_id, "limit": b.limit, "started_at": b.started_at,
                     "info": {"discovery_rounds": 1, "stage_seconds": {"facets": 1.0}}, "usage": []})
    con = db.private()
    con.execute("INSERT INTO builds(build_id, started_at, status, stages_json) VALUES (?,?,?,?)",
                (b.build_id, b.started_at, "running:describe", json.dumps(stages)))
    con.commit()
    for mod in ("facets", "discover", "classify", "leftovers", "hierarchy", "describe"):   # must not re-run
        monkeypatch.setattr(f"logless.pipeline.{mod}.run", lambda build, mod=mod: (_ for _ in ()).throw(AssertionError(mod)))
    return b


def test_gate_fails_cleanly_on_402_then_resumes(tmp_data, monkeypatch):
    b = _described_build(tmp_data, monkeypatch)
    monkeypatch.setattr(util, "glm_json", _fake_glm)
    monkeypatch.setattr(util, "jev_ask", lambda state, q: (_ for _ in ()).throw(BILLING))
    with pytest.raises(SystemExit) as e:
        runmod.main(from_stage="gate", no_cache=True)
    assert "stage gate failed: jev unavailable: billing_error" in str(e.value)
    row = db.private().execute("SELECT status FROM builds WHERE build_id = ?", (b.build_id,)).fetchone()
    assert row["status"] == "failed:gate"
    assert not b.has("structure_described_gated")  # nothing half-written by the failed gate
    # credits topped up: the same build resumes from the gate without redoing earlier stages
    monkeypatch.setattr(util, "jev_ask", _fake_jev)
    assert runmod.main(from_stage="gate", no_cache=True) == 0
    row = db.private().execute("SELECT status, snapshot_id FROM builds WHERE build_id = ?", (b.build_id,)).fetchone()
    assert row["status"] == "published" and row["snapshot_id"]
    snap = json.loads(db.public().execute("SELECT json FROM snapshots WHERE is_current = 1").fetchone()[0])
    assert snap["snapshot_id"] == row["snapshot_id"]
    done = [s["stage"] for s in json.loads(db.private().execute("SELECT stages_json FROM builds WHERE build_id = ?",
                                                                (b.build_id,)).fetchone()[0])]
    assert done[:6] == ["facets", "discover", "classify", "leftovers", "hierarchy", "describe"]
    assert done[6:] == ["gate", "labels", "surprising", "stats", "publish"]


# ---------------------------------------------------------------- intake + search on 402

def test_intake_fails_with_jev_unavailable_before_publishing(tmp_data, monkeypatch):
    from tests.test_intake import _setup
    b, base, ids = _setup(tmp_data, monkeypatch)
    monkeypatch.setattr(intake, "ASK", lambda state, q: (_ for _ in ()).throw(BILLING))
    run = intake.IntakeRun(base, len(ids))
    with pytest.raises(intake.IntakeError) as e:
        intake.run_batch(run, evaluate=lambda s: None)
    assert e.value.code == "jev_unavailable" and "billing_error" in str(e.value)
    assert intake.current_snapshot()["snapshot_id"] == base            # nothing published
    q = ",".join("?" * len(ids))
    assert db.private().execute(f"SELECT COUNT(*) FROM assignments WHERE conv_id IN ({q})", ids).fetchone()[0] == 0
    assert intake.status()["ready"] is True


def test_search_returns_503_model_unavailable_on_402(tmp_data, monkeypatch):
    b = _fake_build(tmp_data, monkeypatch)
    from logless.pipeline import publish, stats
    monkeypatch.setattr("logless.pipeline.stats.save_cluster_map", lambda *a, **k: None)
    stats.run(b)
    publish.run(b)
    from fastapi.testclient import TestClient
    from logless.api import app as appmod
    from logless.api import search
    monkeypatch.setattr(search, "run", lambda snap, q: (_ for _ in ()).throw(BILLING))
    monkeypatch.setattr(search, "cached", lambda key: None)
    snap_id = db.public().execute("SELECT snapshot_id FROM snapshots WHERE is_current = 1").fetchone()[0]
    with TestClient(appmod.create_app()) as c:   # runs the lifespan (fresh executors)
        r = c.post("/api/search", json={"query": "cover letters", "snapshot_id": snap_id})
    assert r.status_code == 503 and r.json()["code"] == "model_unavailable"
    assert "billing" not in r.text and "credits" not in r.text   # no provider detail leaks to the browser


def test_facets_stage_surfaces_provider_unavailable(tmp_data, monkeypatch):
    b = _fake_build(tmp_data, monkeypatch)
    from logless.pipeline import facets
    monkeypatch.setattr(facets, "extract_one", lambda c, t: (_ for _ in ()).throw(ProviderError("glm", 402, "billing_error")))
    monkeypatch.setattr(facets, "friction_one", lambda *a: {})
    with pytest.raises(util.ProviderUnavailable, match="glm unavailable: billing_error"):
        facets.run(b)
