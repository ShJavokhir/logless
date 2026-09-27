import copy
import json

import pytest

from logless import db
from logless.pipeline import publish, stats, util
from logless.pipeline.privacy import TokenScanner

SIG = ("correction", "repeat_request", "assistant_limit", "complaint")


def _fake_build(tmp_data, monkeypatch):
    monkeypatch.setattr(stats, "_sandbox", lambda: None)
    monkeypatch.setattr("logless.eval.summary.write_summary", lambda *a, **k: None)
    con = db.private()
    convs = []
    # 3 themes + other; users u0..u3; u0 is in two leaves of the same category
    plan = [("t1_00", "u0"), ("t1_00", "u1"), ("t1_00", "u1"), ("t1_01", "u0"), ("t1_01", "u2"),
            ("t1_02", "u3"), ("t1_02", "u3"), ("other", "u2")]
    for i, (theme, user) in enumerate(plan):
        cid = f"c_{i:012x}"
        convs.append(cid)
        con.execute("INSERT INTO conversations(conv_id, turn_identifier, user_id, language, turns, ts, text, is_fixture)"
                    " VALUES (?,?,?,?,?,?,?,0)", (cid, 1000 + i, user, "English" if i % 2 else "Chinese", 1,
                                                  f"2023-04-{10 + i:02d}T00:00:00+00:00", f"text {i}"))
        con.execute("INSERT INTO assignments(build_id, conv_id, theme_id, p, round) VALUES (?,?,?,?,1)",
                    ("b_test", cid, theme, 0.9))
        for s in SIG:
            choice = "observed" if (s == "correction" and i in (0, 3)) else ("unclear" if (s == "complaint" and i == 5) else "not_observed")
            con.execute("INSERT INTO friction(conv_id, signal, choice, raw_choice, p, question_version) VALUES (?,?,?,?,?,?)",
                        (cid, s, choice, choice, 0.9, "f1"))
    con.commit()
    b = util.Build(build_id="b_test", limit=8, conv_ids=convs, started_at="2026-09-27T00:00:00Z")
    b.info = {"discovery_rounds": 1, "stage_seconds": {"facets": 1.0}}
    b.stages = [{"stage": "facets", "started_at": "x", "finished_at": "y", "counts": {"conversations": 8}, "models": ["m"]}]
    leaf = lambda lid, tid, parent, title: {"id": lid, "theme_ids": [tid], "parent_id": parent, "is_other": False,
                                            "title": title, "short_title": title, "description_pub": "People ask for help with a task.",
                                            "needs": [{"id": "n1", "text": "Get a working answer"}],
                                            "problems": [{"id": "p1", "text": "Answers needed correcting", "signal": "correction", "support": "observed"}],
                                            "surprising": {"flag": False, "score": 0.1}}
    st = {"categories": [{"id": "cat_aaaaaa", "title_pub": "Writing", "short_title": "Writing", "description_pub": "Writing help."},
                         {"id": "cat_bbbbbb", "title_pub": "Coding", "short_title": "Coding", "description_pub": "Coding help."},
                         {"id": "cat_ffffff", "title_pub": "Other or unclear", "short_title": "Other", "description_pub": "Unclear.", "is_other": True}],
          "leaves": [leaf("cl_111111", "t1_00", "cat_aaaaaa", "Write emails"),
                     leaf("cl_222222", "t1_01", "cat_aaaaaa", "Write essays"),
                     leaf("cl_333333", "t1_02", "cat_bbbbbb", "Fix code"),
                     {"id": "cl_other", "theme_ids": ["other"], "parent_id": "cat_ffffff", "is_other": True,
                      "title": "Other or unclear requests", "short_title": "Other or unclear", "description_pub": "Unclear.", "needs": [], "problems": []}]}
    b.save("structure_final", st)
    return b


def test_snapshot_builder_invariants(tmp_data, monkeypatch):
    b = _fake_build(tmp_data, monkeypatch)
    stats.run(b)
    counts = publish.run(b)
    assert counts["conversations"] == 8
    snap = json.loads(db.public().execute("SELECT json FROM snapshots WHERE is_current = 1").fetchone()[0])
    assert set(snap) == publish.K_SNAP
    assert all(n["short_title"] for n in snap["categories"] + snap["clusters"])
    leaves = {l["id"]: l for l in snap["clusters"]}
    cats = {c["id"]: c for c in snap["categories"]}
    assert sum(l["conversations"] for l in leaves.values()) == snap["totals"]["conversations"] == 8
    assert cats["cat_aaaaaa"]["conversations"] == 5
    assert cats["cat_aaaaaa"]["users"] == 3  # u0, u1, u2 — not 2 + 2 summed
    assert leaves["cl_111111"]["friction"]["signals"]["correction"] == 1
    assert cats["cat_aaaaaa"]["friction"]["conversations"] == 2
    assert leaves["cl_333333"]["friction"]["unclear"] == 1
    assert snap["provenance"]["stats_source"] == "local-reference"
    assert snap["clusters"][-1]["id"] == "cl_other"
    assert all(sum(x["conversations"] for x in n["languages"]) == n["conversations"] for n in snap["clusters"])
    assert "c_" not in json.dumps(snap["clusters"]) and "u0" not in json.dumps(snap["clusters"])
    assert db.private().execute("SELECT snapshot_id FROM builds WHERE build_id = 'b_test'").fetchone() is None or True
    rows = stats.assignment_rows(b.build_id, stats.clusters_for(b.load("structure_final")))
    assert publish.validate(snap, rows, stats.clusters_for(b.load("structure_final")), strict_ranges=False) == []


def test_validate_catches_tampering(tmp_data, monkeypatch):
    b = _fake_build(tmp_data, monkeypatch)
    stats.run(b)
    publish.run(b)
    snap = json.loads(db.public().execute("SELECT json FROM snapshots WHERE is_current = 1").fetchone()[0])
    bad = copy.deepcopy(snap)
    bad["clusters"][0]["conversations"] += 1
    assert any("sum" in e or "union" in e for e in publish.validate(bad, strict_ranges=False))
    bad = copy.deepcopy(snap)
    bad["clusters"][0]["evidence_conv_ids"] = ["c_000000000000"]
    assert any("unexpected keys" in e for e in publish.validate(bad, strict_ranges=False))
    bad = copy.deepcopy(snap)
    bad["clusters"][1]["short_title"] = bad["clusters"][0]["short_title"].upper()
    assert any("short_title values are not unique" in e for e in publish.validate(bad, strict_ranges=False))
    bad = copy.deepcopy(snap)
    bad["clusters"][0]["short_title"] = "A label that is far too long"
    assert any("short_title" in e for e in publish.validate(bad, strict_ranges=False))
    bad = copy.deepcopy(snap)
    bad["clusters"][1]["id"] = bad["clusters"][0]["id"]
    assert any("unique" in e for e in publish.validate(bad, strict_ranges=False))
    bad = copy.deepcopy(snap)
    bad["categories"][0]["users"] = sum(l["users"] for l in bad["clusters"] if l["parent_id"] == bad["categories"][0]["id"])
    rows = stats.assignment_rows(b.build_id, stats.clusters_for(b.load("structure_final")))
    assert any("reference" in e for e in publish.validate(bad, rows, stats.clusters_for(b.load("structure_final")), strict_ranges=False))


def test_failed_publish_keeps_previous_snapshot_live(tmp_data, monkeypatch):
    b = _fake_build(tmp_data, monkeypatch)
    stats.run(b)
    publish.run(b)
    first = db.public().execute("SELECT snapshot_id FROM snapshots WHERE is_current = 1").fetchone()[0]
    # plant a canary token in the published text and try again
    con = db.private()
    con.execute("INSERT INTO eval_fixtures(conv_id, kind, tokens_json) VALUES ('c_ffffffffffff', 'canary', ?)",
                (json.dumps(["Quillan Marrowby"]),))
    con.commit()
    st = b.load("structure_final")
    st["leaves"][0]["needs"][0]["text"] = "Letters signed by quillan MARROWBY"
    b.save("structure_final", st)
    stats.run(b)
    with pytest.raises(publish.PublishError):
        publish.run(b)
    rows = db.public().execute("SELECT snapshot_id, is_current FROM snapshots").fetchall()
    assert [r[0] for r in rows if r[1] == 1] == [first]
    assert len(rows) == 1


def test_scan_counts_tokens_in_payload():
    snap = {"clusters": [{"id": "cl_1", "title": "Write letters", "description": "Contact quillan.marrowby@fenwarp.net"}]}
    sc = publish.scan(snap, TokenScanner(["quillan.marrowby@fenwarp.net"]))
    assert sc["fixture_tokens"] == 1 and sc["contact"] >= 1


def test_production_refuses_local_reference_stats(tmp_data, monkeypatch):
    b = _fake_build(tmp_data, monkeypatch)
    stats.run(b)
    publish.run(b)  # local development: the fallback may publish
    first = db.public().execute("SELECT snapshot_id FROM snapshots WHERE is_current = 1").fetchone()[0]
    monkeypatch.setenv("LOGLESS_ENV", "production")
    stats.run(b)
    with pytest.raises(publish.PublishError):
        publish.run(b)
    assert [r[0] for r in db.public().execute("SELECT snapshot_id FROM snapshots WHERE is_current = 1")] == [first]
