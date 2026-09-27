"""Sub-themes side layer: pure parts (k clamp, folding, sum check, title checks) and the read endpoint."""
from __future__ import annotations

import json

from logless.pipeline import subthemes as st
from test_api_app import client, no_private  # noqa: F401 — fixture reuse

LEAF = "cl_abc123"


def _group(prefix: str, n: int, people: int) -> tuple[list[str], dict[str, str]]:
    convs = [f"{prefix}{i}" for i in range(n)]
    return convs, {c: f"u{prefix}{i % people}" for i, c in enumerate(convs)}


def test_choose_k_clamps():
    assert st.choose_k(30) == 2
    assert st.choose_k(100) == 2
    assert st.choose_k(140) == 4   # round(3.5) -> 4 (banker's rounding on .5 gives 4)
    assert st.choose_k(200) == 5
    assert st.choose_k(653) == 6
    assert st.choose_k(10_000) == 6


def test_fold_rest_ordering_and_sum():
    a, ua = _group("a", 20, 10)
    b, ub = _group("b", 40, 12)
    small, us = _group("s", 7, 7)        # < 8 conversations
    few, uf = _group("f", 12, 3)         # < 5 people
    users = {**ua, **ub, **us, **uf, "m1": "um", "m2": "um"}
    items, members = st.fold(LEAF, [a, b, small, few], users, extra_rest=["m1", "m2"])
    assert [x["id"] for x in items] == [f"{LEAF}_s1", f"{LEAF}_s2", f"{LEAF}_rest"]
    assert items[0]["conversations"] == 40 and items[1]["conversations"] == 20
    assert items[2] == {"id": f"{LEAF}_rest", "short_title": None, "conversations": 7 + 12 + 2,
                        "users": 7 + 3 + 1, "rest": True}
    assert sum(x["conversations"] for x in items) == 20 + 40 + 7 + 12 + 2
    assert set(members) == {x["id"] for x in items}
    assert not st.check_sums({LEAF: items}, {LEAF: 81})
    assert st.check_sums({LEAF: items}, {LEAF: 80})


def test_fold_fewer_than_two_real_gives_empty():
    a, ua = _group("a", 30, 10)
    small, us = _group("s", 5, 5)
    items, members = st.fold(LEAF, [a, small], {**ua, **us})
    assert items == [] and members == {}
    # no rest item when nothing folds
    b, ub = _group("b", 10, 6)
    items, _ = st.fold(LEAF, [a, b], {**ua, **ub})
    assert [x["id"] for x in items] == [f"{LEAF}_s1", f"{LEAF}_s2"] and not any(x.get("rest") for x in items)


def test_title_problems():
    p = st.title_problems({"x1": "Cover letters", "x2": "cover letters", "x3": "Job hunt help", "x4": "Top 10 tips",
                           "x5": "Way too many words here", "x6": ""}, ["Job hunt help", "Job applications"])
    assert "x1" in p and "x2" in p           # case-insensitive duplicate
    assert "x3" in p                          # repeats the parent label
    assert "x4" in p and "x5" in p and "x6" in p
    assert not st.title_problems({"a": "Cover letters", "b": "Interview prep"}, ["Job hunt help"])


def test_subthemes_endpoint(client):
    from logless import db
    sid = client.get("/api/health").json()["snapshot_id"]
    r = client.get("/api/subthemes")
    assert r.status_code == 404 and r.json()["code"] == "not_found"
    assert client.get("/api/subthemes", params={"snapshot_id": "nope"}).status_code == 404
    bid = db.private().execute("SELECT build_id FROM builds WHERE snapshot_id=?", (sid,)).fetchone()["build_id"]
    leaf = client.get("/api/snapshot").json()["clusters"][0]["id"]
    doc = {"build_id": bid, "base_snapshot_id": sid, "leaves": {leaf: [
        {"id": f"{leaf}_s1", "short_title": "Cover letters", "conversations": 9, "users": 6, "private": "x"},
        {"id": f"{leaf}_s2", "short_title": None, "conversations": 8, "users": 5},
        {"id": f"{leaf}_rest", "short_title": None, "conversations": 3, "users": 2, "rest": True}]}}
    con = db.public()
    con.execute(st.SCHEMA)
    with db.write(con):
        con.execute("INSERT INTO subthemes(build_id, snapshot_id, created_at, json) VALUES (?,?,?,?)",
                    (bid, sid, "2026-09-27T00:00:00Z", json.dumps(doc)))
    for params in ({}, {"snapshot_id": sid}):
        r = client.get("/api/subthemes", params=params)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["snapshot_id"] == sid and body["base_snapshot_id"] == sid
        items = body["leaves"][leaf]
        assert items[0] == {"id": f"{leaf}_s1", "short_title": "Cover letters", "conversations": 9, "users": 6}
        assert items[2]["rest"] is True and "rest" not in items[1]
        no_private(r.text)
