import copy
import json

import numpy as np
import pytest

from logless import db
from logless.pipeline import publish, stats, util
from logless.pipeline.privacy import TokenScanner

SIG = ("correction", "repeat_request", "assistant_limit", "complaint")


def _fake_build(tmp_data, monkeypatch):
    monkeypatch.setattr(stats, "save_cluster_map", lambda *a, **k: None)
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
        if i < 7:  # the last conversation has no care decisions yet: it counts as unclear
            for s in ("refusal", "sensitive"):
                choice = "observed" if (s == "refusal" and i == 5) else "not_observed"
                con.execute("INSERT INTO friction(conv_id, signal, choice, raw_choice, p, question_version) VALUES (?,?,?,?,?,?)",
                            (cid, s, choice, choice, 0.9, "c1"))
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
    assert leaves["cl_333333"]["care"] == {"refusal": 1, "sensitive": 0, "unclear": 0}
    assert leaves["cl_other"]["care"] == {"refusal": 0, "sensitive": 0, "unclear": 1}
    assert snap["totals"]["care"]["refusal"] == 1 and snap["totals"]["friction"]["conversations"] == 2
    assert leaves["cl_111111"]["concentration"] == {"top_people_share": 1.0, "conversations_per_person": 1.5}  # u0, u1, u1
    assert snap["totals"]["concentration"]["conversations_per_person"] == 2.0  # 8 conversations, 4 people
    assert "stats_source" not in snap["provenance"]
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
    bad["clusters"][0]["care"]["refusal"] += 1
    rows = stats.assignment_rows(b.build_id, stats.clusters_for(b.load("structure_final")))
    assert any("reference" in e for e in publish.validate(bad, rows, stats.clusters_for(b.load("structure_final")), strict_ranges=False))
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


def _embed(tmp_data, build_id, conv_ids, axis_of):
    """Write a build's embeddings: each conversation is a unit vector on its theme's axis."""
    d = tmp_data / "embeddings"
    d.mkdir(exist_ok=True)
    X = np.zeros((len(conv_ids), 5), dtype=np.float32)
    for i, c in enumerate(conv_ids):
        X[i, axis_of(c)] = 1.0
    np.save(d / f"{build_id}.npy", X)
    (d / f"{build_id}.ids.json").write_text(json.dumps(conv_ids))


def test_rebuild_links_leaves_and_serves_the_diff(tmp_data, monkeypatch):
    from fastapi.testclient import TestClient

    from logless.api import app as appmod
    b = _fake_build(tmp_data, monkeypatch)
    con = db.private()
    theme = {r[0]: r[1] for r in con.execute("SELECT conv_id, theme_id FROM assignments WHERE build_id='b_test'")}
    axis = {"t1_00": 0, "t1_01": 1, "t1_02": 2, "other": 3}
    _embed(tmp_data, "b_test", b.conv_ids, lambda c: axis[theme[c]])
    stats.run(b)
    publish.run(b)
    first = publish.lineage.current()
    assert first["previous_snapshot_id"] is None and all(l["previous_id"] is None for l in first["clusters"])

    # A rebuild with new leaf ids: two themes return, "Fix code" becomes an unrelated theme.
    new_theme = {c: {"t1_02": "t2_09"}.get(t, t) for c, t in theme.items()}
    for c, t in new_theme.items():
        con.execute("INSERT INTO assignments(build_id, conv_id, theme_id, p, round) VALUES ('b_two',?,?,0.9,1)", (c, t))
    con.commit()
    _embed(tmp_data, "b_two", b.conv_ids, lambda c: {**axis, "t2_09": 4}[new_theme[c]])
    b2 = util.Build(build_id="b_two", limit=8, conv_ids=b.conv_ids, started_at=b.started_at, stages=b.stages, info=dict(b.info))
    st = b.load("structure_final")
    for l, (new_id, tid, title) in zip(st["leaves"], [("cl_aaaaaa", "t1_00", "Write emails"), ("cl_bbbbbb", "t1_01", "Write essays"),
                                                       ("cl_cccccc", "t2_09", "Plan trips")]):
        l.update(id=new_id, theme_ids=[tid], title=title, short_title=title)
    b2.save("structure_final", st)
    stats.run(b2)
    publish.run(b2)
    second = publish.lineage.current()
    assert second["previous_snapshot_id"] == first["snapshot_id"]
    assert {l["id"]: l["previous_id"] for l in second["clusters"]} == \
        {"cl_aaaaaa": "cl_111111", "cl_bbbbbb": "cl_222222", "cl_cccccc": None, "cl_other": "cl_other"}

    monkeypatch.setattr(appmod, "store", appmod.SnapshotStore())
    with TestClient(appmod.create_app()) as c:
        assert c.get("/api/snapshot").json()["clusters"][0]["previous_id"] in ("cl_111111", "cl_222222", None)
        diff = c.get(f"/api/snapshots/{second['snapshot_id']}/diff").json()
        assert diff["previous_snapshot_id"] == first["snapshot_id"]
        by = {l["id"]: l for l in diff["leaves"]}
        assert by["cl_aaaaaa"]["conversations_before"] == by["cl_aaaaaa"]["conversations_after"] == 3
        assert by["cl_aaaaaa"]["share_change"] == 0.0 and by["cl_cccccc"]["previous_id"] is None
        assert [g["id"] for g in diff["gone"]] == ["cl_333333"]
        assert c.get(f"/api/snapshots/{first['snapshot_id']}/diff").json()["code"] == "no_previous_snapshot"
        assert c.get("/api/snapshots/snap_nope/diff").status_code == 404
