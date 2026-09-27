"""Offline tests for scripts/story_example.py: fakes for every provider, and proof that nothing is written."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
from pathlib import Path

import numpy as np
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "story_example.py"
BUILD = "b_20260926T120000"
SNAP = "s_story_test"


def _load():
    spec = importlib.util.spec_from_file_location("story_example", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _choice(probs: dict[str, float]) -> dict:
    return {"type": "choice", "choice": max(probs, key=probs.get), "probabilities": probs}


def _setup(tmp_data) -> None:
    from logless import db
    from logless.config import settings
    from logless.data import fixtures

    s = settings()
    con, pub = db.private(), db.public()
    rows = fixtures.build()
    con.executemany("INSERT INTO eval_fixtures(conv_id, kind, tokens_json) VALUES (?,?,?)",
                    [(r["conv_id"], r["kind"], json.dumps(r["tokens"])) for r in rows])
    con.execute("INSERT INTO builds(build_id, started_at, status, stages_json, snapshot_id) VALUES (?,?,?,?,?)",
                (BUILD, "2026-09-26T12:00:00Z", "published", "[]", SNAP))
    ids = [f"c_{i:012x}" for i in range(30)]
    con.executemany("INSERT INTO assignments(build_id, conv_id, theme_id, p, round) VALUES (?,?,?,?,1)",
                    [(BUILD, c, "t1_00" if i < 20 else ("t1_01" if i < 28 else "other"), 0.9) for i, c in enumerate(ids)])
    con.commit()
    st = {"leaves": [
        {"id": "cl_data", "title": "Write and fix data scripts", "short_title": "Data scripts", "parent_id": "cat_code",
         "is_other": False, "theme_ids": ["t1_00"], "description_pub": "Scripts that process tabular data."},
        {"id": "cl_letters", "title": "Write cover letters", "short_title": "Cover letters", "parent_id": "cat_write",
         "is_other": False, "theme_ids": ["t1_01"], "description_pub": "Job application letters."},
        {"id": "cl_other", "title": "Other or unclear", "short_title": "Other", "parent_id": "cat_other",
         "is_other": True, "theme_ids": ["other"]}],
        "categories": [{"id": "cat_code", "title_pub": "Coding help", "short_title": "Coding"},
                       {"id": "cat_write", "title_pub": "Writing", "short_title": "Writing"},
                       {"id": "cat_other", "title_pub": "Other or unclear", "short_title": "Other", "is_other": True}]}
    snap = {"snapshot_id": SNAP,
            "clusters": [{"id": "cl_data", "title": "Write and fix data scripts", "short_title": "Data scripts",
                          "parent_id": "cat_code", "conversations": 20, "users": 17},
                         {"id": "cl_letters", "title": "Write cover letters", "short_title": "Cover letters",
                          "parent_id": "cat_write", "conversations": 8, "users": 8},
                         {"id": "cl_other", "title": "Other or unclear", "short_title": "Other",
                          "parent_id": "cat_other", "conversations": 2, "users": 2, "is_other": True}],
            "categories": [{"id": "cat_code", "title": "Coding help", "short_title": "Coding", "conversations": 20, "users": 17},
                           {"id": "cat_write", "title": "Writing", "short_title": "Writing", "conversations": 8, "users": 8},
                           {"id": "cat_other", "title": "Other or unclear", "short_title": "Other", "conversations": 2,
                            "users": 2}]}
    pub.execute("INSERT INTO snapshots(snapshot_id, created_at, json, is_current) VALUES (?,?,?,1)",
                (SNAP, "2026-09-26T12:00:00Z", json.dumps(snap)))
    pub.commit()
    art = s.artifacts_dir / BUILD
    art.mkdir(parents=True)
    (art / "build.json").write_text(json.dumps({"build_id": BUILD, "limit": None, "info": {}, "usage": []}))
    (art / "scope.json").write_text(json.dumps(ids))
    (art / "structure_final.json").write_text(json.dumps(st))
    rng = np.random.default_rng(0)
    X = rng.normal(size=(30, 8)).astype(np.float32)
    X[:20, 0] += 6.0     # the data-script conversations sit near the synthetic query
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    emb = s.data_dir / "embeddings"
    emb.mkdir()
    np.save(emb / f"{BUILD}.npy", X)
    (emb / f"{BUILD}.ids.json").write_text(json.dumps(ids))
    for c in db._local.cons.values():   # checkpoint + close so the files are stable before the run
        c.close()
    db._local.cons = {}


def _fakes(monkeypatch, *, pii=(0.1,), calls=None):
    from logless import intake
    from logless.pipeline import util
    from logless.pipeline.prompts import Facets
    from logless.pipeline.questions import FRICTION_Q
    from logless.providers import fireworks

    calls = calls if calls is not None else {}
    pii_iter = iter(pii)

    def glm_json(system, user, schema, **kw):
        calls.setdefault("glm", []).append(kw["model"])
        assert "Dana Whitfield" in user or "user_goal" in user
        return Facets(user_goal="Get a weekly shipping report from exported shipment data.",
                      task="Write a Python script that totals shipment weight per destination from a CSV file.",
                      domain="python csv processing", language="English")

    def jev_ask(state, questions):
        calls.setdefault("jev_ask", []).append(sorted(questions))
        return {"identifying": {"type": "noul", "noul": next(pii_iter)}}

    def embed(texts, **kw):
        calls.setdefault("embed", []).append(list(texts))
        v = np.zeros((len(texts), 8), dtype=np.float32)
        v[:, 0] = 1.0
        return v

    def ask(state, questions):
        calls["ask_state_keys"] = sorted(state)
        calls["ask_questions"] = sorted(questions)
        ans = {s: _choice({"observed": 0.1, "not_observed": 0.85, "unclear": 0.05}) for s in FRICTION_Q}
        ans["correction"] = _choice({"observed": 0.92, "not_observed": 0.05, "unclear": 0.03})
        ans["repeat_request"] = _choice({"observed": 0.55, "not_observed": 0.4, "unclear": 0.05})
        ans["theme"] = _choice({"Write and fix data scripts": 0.81, "Write cover letters": 0.04, "Other or unclear": 0.15})
        return ans

    monkeypatch.setattr(util, "glm_json", glm_json)
    monkeypatch.setattr(util, "jev_ask", jev_ask)
    monkeypatch.setattr(fireworks, "embed", embed)
    monkeypatch.setattr(intake, "ASK", ask)
    return calls


def _digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_transcript_is_clean_and_shaped(tmp_data):
    from logless.data import fixtures
    se = _load()
    tokens = [t for r in fixtures.build() for t in r["tokens"]]
    text = se.render(se.TRANSCRIPT)
    assert se.transcript_problems(text, tokens) == []
    assert 6 <= len(se.TRANSCRIPT) <= 8
    assert [r for r, _ in se.TRANSCRIPT[:2]] == ["user", "assistant"]
    assert text.startswith("user: ") and "\nassistant: " in text
    assert "Dana Whitfield" in text and "Brightwater Logistics" in text


def test_end_to_end_offline_writes_nothing(tmp_data, monkeypatch, tmp_path):
    from logless import db
    from logless.config import settings
    _setup(tmp_data)
    s = settings()
    before = {p.name: _digest(p) for p in (s.private_db, s.public_db)}
    calls = _fakes(monkeypatch)
    se = _load()
    real_write = db.write
    out_path = tmp_path / "story.json"
    assert se.main(["--out", str(out_path)]) == 0
    out = json.loads(out_path.read_text())

    assert db.write is real_write
    assert {p.name: _digest(p) for p in (s.private_db, s.public_db)} == before
    con = sqlite3.connect(s.private_db)
    assert con.execute("SELECT COUNT(*) FROM llm_cache").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('facet_checks', 'embedding_cache')").fetchone()[0] == 0
    con.close()

    assert out["synthetic"] is True and out["snapshot_id"] == SNAP and out["build_id"] == BUILD
    assert out["transcript"][0]["role"] == "user"
    st = out["stages"]
    assert st["facets"]["pii"]["status"] == "ok" and st["facets"]["pii"]["after"] is None
    assert st["facets"]["fake_name_in_facet_text"] is False and st["facets"]["fake_company_in_facet_text"] is False
    assert st["embedding"]["dims"] == 8 and len(st["embedding"]["first_values"]) == 6
    assert calls["embed"] == [[st["facets"]["facet_text"]]]
    nb = st["neighbours"]
    assert nb["k"] == 25 and sum(x["count"] for x in nb["by_leaf"]) == 25
    assert nb["by_leaf"][0]["leaf_id"] == "cl_data" and nb["by_leaf"][0]["count"] == 20
    assert "c_" not in json.dumps(nb)
    assert calls["ask_state_keys"] == ["conversation", "facets"]
    assert calls["ask_questions"] == sorted(["correction", "repeat_request", "assistant_limit", "complaint", "theme"])
    jv = st["jev"]
    assert jv["theme"]["chosen_leaf_id"] == "cl_data" and jv["theme"]["top"][1]["leaf_id"] == "cl_other"
    assert jv["friction"]["correction"] == {"stored": "observed", "raw_choice": "observed", "p": 0.92}
    assert jv["friction"]["repeat_request"]["stored"] == "unclear"
    pl = st["placement"]
    assert pl["leaf"]["id"] == "cl_data" and pl["leaf"]["people"] == 17
    assert pl["category"] == {"id": "cat_code", "title": "Coding help", "short_title": "Coding",
                              "conversations": 20, "people": 17}


def test_rewrite_path_and_low_confidence_theme(tmp_data, monkeypatch):
    _setup(tmp_data)
    calls = _fakes(monkeypatch, pii=(0.9, 0.2))
    se = _load()
    rec, f, emb_text = None, None, None
    with se.read_only():
        rec, f, emb_text = se.stage_facets(se.render(se.TRANSCRIPT), "glm-5.3-flash")
    assert rec["pii"]["status"] == "rewritten" and rec["pii"]["before"] == 0.9 and rec["pii"]["after"] == 0.2
    assert calls["glm"] == ["glm-5.3-flash", "glm-5.3-flash"]
    assert emb_text == rec["facet_text"]
    ans = {"theme": _choice({"A": 0.5, "B": 0.3, "Other or unclear": 0.2})}
    for sig in ("correction", "repeat_request", "assistant_limit", "complaint"):
        ans[sig] = _choice({"observed": 0.1, "not_observed": 0.8, "unclear": 0.1})
    d = se.jev_decision(ans, {"A": "cl_a", "B": "cl_b"}, {})
    assert d["theme"]["chosen_leaf_id"] == "cl_other" and d["theme"]["below_cutoff"] is True


def test_read_only_guard_refuses_writes(tmp_data):
    from logless import db
    _setup(tmp_data)
    se = _load()
    real_write = db.write
    with se.read_only():
        with pytest.raises(sqlite3.OperationalError):
            db.private().execute("INSERT INTO llm_cache(key, response) VALUES ('k', '{}')")
        with pytest.raises(sqlite3.OperationalError):
            db.public().execute("UPDATE snapshots SET is_current = 0")
        with pytest.raises(RuntimeError):
            with db.write(db.private()):
                pass
    assert db.write is real_write


def test_missing_embeddings_refuses_to_rebuild(tmp_data, monkeypatch):
    from logless.config import settings
    _setup(tmp_data)
    _fakes(monkeypatch)
    npy = settings().data_dir / "embeddings" / f"{BUILD}.npy"
    npy.unlink()
    se = _load()
    with pytest.raises(SystemExit, match="refusing to rebuild"):
        se.run("glm-5.3-flash")
    assert not npy.exists()
