"""Video brief: the gate (order, timing, ids, placeholders, no numbers), code-attached data, API flow."""
from __future__ import annotations

import copy

import pytest

from logless.api import app as appmod
from logless.api import serializers
from logless.api.briefs import normalize_seconds, _BriefOut, facts, global_values, validate
from logless.api.prds import rankable
from logless.providers import glm
from sandbox_helpers import tmp_data  # noqa: F401
from test_api_app import client, wait  # noqa: F401


def _metrics(conv, users, share, fconv, fshare, sig=(1, 2, 3, 4)):
    return {"conversations": conv, "users": users, "share": share,
            "friction": {"conversations": fconv, "share": fshare, "unclear": 1,
                         "signals": dict(zip(("correction", "repeat_request", "assistant_limit", "complaint"), sig))},
            "languages": []}


def _leaf(i, conv, fconv, parent="cat_111111", **kw):
    return {**_metrics(conv, conv // 2, round(conv / 1000, 4), fconv, round(fconv / conv, 4)),
            "id": f"cl_{i:06x}" if isinstance(i, int) else i, "level": 2, "parent_id": parent,
            "title": f"Workflow number {i}", "short_title": f"Flow {chr(65 + i) if isinstance(i, int) else 'Other'}",
            "description": "People do a thing.", "needs": [{"id": "n1", "text": "Get it done"}],
            "problems": [{"id": "p1", "text": "It went wrong", "signal": "correction", "support": "common"}], **kw}


SNAP = {
    "snapshot_id": "snap_20260927T000000_abcd",
    "workspace": {"name": "Test space", "description": "d"},
    "dataset": {"name": "WildChat-1M", "period_start": "2023-04-09", "period_end": "2023-05-04", "languages": 12},
    "totals": {**_metrics(1000, 600, 1.0, 200, 0.2, (40, 90, 60, 20)),
               "languages": [{"name": "English", "conversations": 500}, {"name": "Chinese", "conversations": 300}]},
    "categories": [{**_metrics(900, 500, 0.9, 190, 0.2111), "id": "cat_111111", "level": 1, "parent_id": None,
                    "title": "Coding help", "short_title": "Coding help", "description": "c", "children": []},
                   {**_metrics(100, 90, 0.1, 10, 0.1), "id": "cat_222222", "level": 1, "parent_id": None,
                    "title": "Other", "short_title": "Other", "description": "o", "children": ["cl_other"], "is_other": True}],
    "clusters": [_leaf(1, 300, 30), _leaf(2, 200, 80), _leaf(3, 150, 20), _leaf(4, 100, 25), _leaf(5, 80, 10),
                 _leaf(6, 40, 15), _leaf(7, 30, 10), _leaf("cl_other", 100, 10, parent="cat_222222", is_other=True)],
}


def good(snapshot=SNAP, spot=None):
    ids = [c["id"] for c in rankable(snapshot["clusters"])]
    spot = spot or ids[:2]
    return {
        "title": "Where {conversations} conversations go wrong",
        "scenes": [
            {"type": "intro", "seconds": 6, "headline": "People came for answers", "kicker": "From {people} people in {languages} languages"},
            {"type": "map", "seconds": 8, "headline": "{top_workflow} dominates at {top_workflow_share}"},
            {"type": "top_workflows", "seconds": 6, "headline": "A few workflows carry the load"},
            {"type": "friction", "seconds": 8, "headline": "{hotspot} is where users fight back"},
            {"type": "signals", "seconds": 5, "headline": "Users ask again rather than complain"},
            {"type": "spotlight", "seconds": 8, "headline": "Big and painful", "cluster_id": spot[0],
             "insight": "{friction_share_here} of its {conversations_here} conversations hit friction, mostly wrong answers."},
            {"type": "spotlight", "seconds": 7, "headline": "Small but sharp", "cluster_id": spot[1],
             "insight": "It holds {share} of traffic yet users correct the assistant often."},
            {"type": "takeaways", "seconds": 6, "headline": "What to build next",
             "bullets": ["Verify answers before replying in {hotspot}", "Keep state between turns", "Say clearly when it cannot help"]},
            {"type": "outro", "seconds": 4, "headline": "Fix friction where it lives"},
        ],
    }


def check(doc, snapshot=SNAP):
    return validate(_BriefOut.model_validate(doc), snapshot)


def text(probs):
    return " | ".join(probs)


def test_good_storyboard_is_filled_from_published_metrics():
    probs, out = check(good())
    assert probs == []
    gv = global_values(SNAP)
    assert out["title"] == "Where 1,000 conversations go wrong"
    assert gv["top_workflow"] == "Flow B" and gv["hotspot"] == "Flow C"   # largest vs most friction conversations
    assert out["scenes"][1]["headline"] == "Flow B dominates at 30.0%"
    assert out["scenes"][5]["insight"].startswith("10.0% of its 300 conversations")
    assert sum(s["seconds"] for s in out["scenes"]) * 30 == out["duration_frames"] == 1740
    assert [s["from_frame"] for s in out["scenes"]][:3] == [0, 180, 420]
    names = {m["name"] for m in out["metrics_used"]}
    assert {"conversations", "top_workflow_share", "friction_share_here · Flow B", "share · Flow C"} <= names
    assert any("0 digits" in c for c in out["checks"])


def test_scene_data_comes_from_the_snapshot_not_the_model():
    _, out = check(good())
    by = {s["type"]: s for s in out["scenes"]}
    cats = by["map"]["data"]["categories"]
    assert [c["id"] for c in cats] == ["cat_111111", "cat_222222"] and cats[1]["is_other"] is True
    assert len(cats[0]["children"]) == 7 and cats[0]["children"][0]["title"] == "Flow B"
    top = by["top_workflows"]["data"]["items"]
    assert len(top) == 6 and top[0]["conversations"] == 300 and "cl_other" not in {x["id"] for x in top}
    fr = by["friction"]["data"]
    assert fr["overall_share"] == 0.2 and fr["items"][0]["friction_conversations"] == 80
    sig = by["signals"]["data"]
    assert sig["friction_conversations"] == 200 and sig["items"][0] == {"signal": "repeat_request", "label": "Asked again", "conversations": 90}
    spot = out["scenes"][5]["data"]
    assert spot["id"] == out["scenes"][5]["cluster_id"] and spot["conversations"] == 300 and spot["problems"] == ["It went wrong"]
    assert by["outro"]["data"]["snapshot_id"] == SNAP["snapshot_id"]
    assert by["intro"].get("data") is None and by["takeaways"].get("data") is None


def test_digits_percent_and_number_words_rejected():
    for bad in ("Nearly 20 users struggle", "Friction hits 20% of chats", "Two workflows dominate usage",
                "Most users ask again", "Half of all chats stall", "A one-off question wins"):
        doc = good()
        doc["scenes"][2]["headline"] = bad
        probs, out = check(doc)
        assert probs and out == {}, bad
        assert "no digits" in text(probs) or "no number words" in text(probs)


def test_bad_placeholders_and_braces_rejected():
    doc = good()
    doc["scenes"][1]["headline"] = "Usage peaks at {share} here"       # spotlight-only placeholder outside a spotlight
    doc["scenes"][2]["headline"] = "Look at {secret} now"
    doc["scenes"][3]["headline"] = "Braces { without placeholders"
    t = text(check(doc)[0])
    assert "{share}" in t and "{secret}" in t and "braces are only for placeholders" in t


def test_order_and_counts_rejected():
    doc = good()
    doc["scenes"][7], doc["scenes"][6] = doc["scenes"][6], doc["scenes"][7]    # takeaways not right before outro
    assert "takeaways must appear exactly once, directly before outro" in text(check(doc)[0])
    doc = good()
    doc["scenes"] = doc["scenes"][1:] + doc["scenes"][:1]
    t = text(check(doc)[0])
    assert "first scene must be intro" in t and "last scene must be outro" in t
    doc = good()
    doc["scenes"] = [s for s in doc["scenes"] if s["type"] != "map"]
    assert "a map scene is required" in text(check(doc)[0])
    doc = good()
    doc["scenes"].insert(3, {"type": "languages", "seconds": 3, "headline": "Every language, same pain"})
    doc["scenes"].insert(3, {"type": "languages", "seconds": 3, "headline": "Every language, same pain"})
    t = text(check(doc)[0])
    assert "use 6-10 scenes" in t and "languages may appear only once" in t
    doc = good()
    doc["scenes"][2]["type"] = "montage"
    assert "scene type must be one of" in text(check(doc)[0])


def test_durations_normalised_not_rejected():
    doc = good()
    doc["scenes"][1]["seconds"] = 20
    probs, filled = check(doc)
    assert probs == []
    secs = [s["seconds"] for s in filled["scenes"]]
    assert all(3 <= x <= 12 for x in secs) and 50 <= sum(secs) <= 62
    doc = good()
    for s in doc["scenes"]:
        s["seconds"] = 3
    probs, filled = check(doc)
    assert probs == [] and sum(s["seconds"] for s in filled["scenes"]) == 58
    assert "pacing normalised by code" in filled["checks"][0]
    assert filled["duration_frames"] == 58 * 30
    assert [s["from_frame"] for s in filled["scenes"]][1] == filled["scenes"][0]["frames"]


def test_normalize_seconds():
    assert normalize_seconds([5, 7, 5, 7, 5, 7, 7, 4, 8, 4]) == [5, 7, 5, 7, 5, 7, 7, 4, 8, 4]
    for prop in ([12] * 10, [1] * 6, [30, 3, 3, 3, 3, 3], [3] * 10):
        out = normalize_seconds(prop)
        assert all(3 <= x <= 12 for x in out) and 50 <= sum(out) <= 62


def test_spotlight_ids_must_be_rankable_and_distinct():
    ids = [c["id"] for c in rankable(SNAP["clusters"])]
    assert "must be a workflow id" in text(check(good(spot=["cl_other", ids[0]]))[0])
    assert "must be a workflow id" in text(check(good(spot=["cl_zzzzzz", ids[0]]))[0])
    assert "different workflows" in text(check(good(spot=[ids[0], ids[0]]))[0])
    doc = good()
    doc["scenes"] = [s for s in doc["scenes"] if s["type"] != "spotlight"]
    doc["scenes"][1]["seconds"] = 12
    assert "one or two spotlight scenes" in text(check(doc)[0])


def test_text_lengths_and_privacy_rejected():
    doc = good()
    doc["scenes"][2]["headline"] = "Growth"
    doc["scenes"][3]["headline"] = "Users in london struggle"
    doc["scenes"][7]["bullets"] = doc["scenes"][7]["bullets"][:2]
    doc["scenes"][4]["headline"] = "Write to someone@example.com for help"
    t = text(check(doc)[0])
    assert "must be 2-10 words" in t and "no cities" in t and "exactly 3 bullets" in t
    doc = good()
    doc["scenes"][4]["headline"] = "Write to someone@example.com for help"
    assert check(doc)[0] == ["no contact details, links or identifiers"]


def test_facts_sheet_has_no_rows_and_rounded_numbers():
    f = facts(SNAP)
    assert f["totals"]["friction_share"] == "20.0%" and f["totals"]["conversations"] == "1,000"
    assert {w["id"] for w in f["workflows"]} == {c["id"] for c in rankable(SNAP["clusters"])}
    assert f["workflows"][0]["share"] == "30.0%" and "hotspot" in f["placeholders"]


def _stored_brief(snapshot=SNAP):
    from logless.api.briefs import assemble
    _, filled = check(good(snapshot), snapshot)
    return assemble(filled, snapshot, model="glm-5.3", attempts=1)


def test_serializer_drops_unknown_fields_and_checks_types():
    raw = _stored_brief()
    raw["secret"] = "x"
    raw["scenes"][0]["conv_id"] = "c_0123456789ab"
    raw["scenes"][1]["data"]["categories"][0]["user_id"] = "u_0123456789"
    raw["scenes"][2]["kicker"] = "stray kicker"
    raw["video_url"] = "https://evil.example"
    out = serializers.serialize_brief(raw)
    assert "secret" not in out and "conv_id" not in out["scenes"][0] and "kicker" not in out["scenes"][2]
    assert "user_id" not in out["scenes"][1]["data"]["categories"][0] and out["video_url"] is None
    assert out["scenes"][0]["kicker"] and out["totals"]["people"] == 600
    bad = copy.deepcopy(_stored_brief())
    bad["scenes"][5]["data"]["conversations"] = "300"
    with pytest.raises(serializers.Blocked):
        serializers.serialize_brief(bad)
    bad = copy.deepcopy(_stored_brief())
    bad["scenes"][0]["headline"] = "Leaked c_0123456789ab"
    with pytest.raises(serializers.Blocked):
        serializers.serialize_brief(bad)


# ---------------------------------------------------------------- API flow (dev fixture snapshot)

def test_brief_api_flow(client, monkeypatch):
    snap = client.get("/api/snapshot").json()
    calls = []

    def fake(system, user, schema, **kw):
        assert schema.__name__ == "_BriefOut"
        calls.append(user)
        doc = good(snap)
        if len(calls) == 1:
            doc["scenes"][2]["headline"] = "Two workflows dominate"   # rejected once, repaired
        return schema.model_validate(doc), {"model": "glm-5.3"}
    monkeypatch.setattr(glm, "chat_json", fake)
    from logless.api.ratelimit import LIMITS, RateLimiter
    monkeypatch.setattr(appmod, "limiter", RateLimiter({**LIMITS, "brief": (50, 10.0)}))  # one test IP

    assert client.get("/api/brief").json() == {"status": "none"}
    r = client.post("/api/brief", json={}).json()
    assert r["status"] == "pending"
    d = wait(client, r["run_id"])
    assert d["state"] == "completed" and d["kind"] == "brief"
    assert [s["name"] for s in d["stages"]] == ["reading", "directing", "checking", "directing", "checking"]
    assert "no number words" in calls[1]
    g = client.get("/api/brief").json()
    assert g["status"] == "ready"
    b = g["brief"]
    assert b["snapshot_id"] == snap["snapshot_id"] and b["attempts"] == 2 and b["fps"] == 30
    assert b["totals"]["conversations"] == snap["totals"]["conversations"]
    assert f"{snap['totals']['conversations']:,}" in b["title"] and not any("{" in s["headline"] for s in b["scenes"])
    assert client.get(f"/api/brief?snapshot_id={snap['snapshot_id']}").json()["brief"]["brief_id"] == b["brief_id"]
    assert client.get("/api/brief?snapshot_id=snap_20200101T000000_0000").json() == {"status": "none"}
    assert client.get("/api/brief?snapshot_id=bogus").json() == {"status": "none"}

    again = client.post("/api/brief", json={"snapshot_id": snap["snapshot_id"]}).json()
    assert again["status"] == "ready" and again["brief"]["brief_id"] == b["brief_id"] and len(calls) == 2
    assert client.post("/api/brief").json()["status"] == "ready"          # no body at all
    regen = client.post("/api/brief", json={"regenerate": True}).json()
    assert regen["status"] == "pending"
    wait(client, regen["run_id"])
    newer = client.get("/api/brief").json()["brief"]
    assert newer["brief_id"] != b["brief_id"]
    assert client.post("/api/brief", json={"snapshot_id": "snap_20200101T000000_0000"}).status_code == 409
    assert client.post("/api/brief", json={"extra": 1}).status_code == 422


def test_brief_rejected_after_one_repair(client, monkeypatch):
    snap = client.get("/api/snapshot").json()

    def fake(system, user, schema, **kw):
        doc = good(snap)
        doc["title"] = "Twenty reasons users leave"
        return schema.model_validate(doc), {"model": "glm-5.3"}
    monkeypatch.setattr(glm, "chat_json", fake)
    d = wait(client, client.post("/api/brief", json={}).json()["run_id"])
    assert d["state"] == "failed" and d["error"]["code"] == "brief_rejected"
    assert client.get("/api/brief").json() == {"status": "none"}


def test_brief_rate_bucket():
    assert appmod.bucket_for("POST", "/api/brief") == "brief"
    assert appmod.bucket_for("GET", "/api/brief") == "default"


# ---------------------------------------------------------------- MP4 export

def test_video_player_only_without_renderer(client, monkeypatch):
    from logless.api import brief_video
    monkeypatch.delenv("BRIEF_RENDER_SCRIPT", raising=False)
    monkeypatch.delenv("BRIEF_RENDER_BUNDLE", raising=False)
    snap = client.get("/api/snapshot").json()
    monkeypatch.setattr(glm, "chat_json", lambda s, u, schema, **kw: (schema.model_validate(good(snap)), {"model": "glm-5.3"}))
    wait(client, client.post("/api/brief", json={}).json()["run_id"])
    b = client.get("/api/brief").json()["brief"]
    assert b["video_status"] == "unavailable" and b["video_url"] is None
    assert not brief_video.enabled()
    assert client.get(f"/api/brief/{b['brief_id']}/video.mp4").status_code == 404
    assert client.get("/api/brief/..%2F..%2Fetc%2Fpasswd/video.mp4").status_code == 404
    assert brief_video.video_path("../../etc/passwd") is None


def test_video_served_when_rendered(client, monkeypatch, tmp_path):
    from logless.api import brief_video
    snap = client.get("/api/snapshot").json()
    monkeypatch.setattr(glm, "chat_json", lambda s, u, schema, **kw: (schema.model_validate(good(snap)), {"model": "glm-5.3"}))
    wait(client, client.post("/api/brief", json={}).json()["run_id"])
    bid = client.get("/api/brief").json()["brief"]["brief_id"]
    d = brief_video.video_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{bid}.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 100)
    b = client.get("/api/brief").json()["brief"]
    assert b["video_status"] == "ready" and b["video_url"] == f"/api/brief/{bid}/video.mp4"
    r = client.get(b["video_url"])
    assert r.status_code == 200 and r.headers["content-type"] == "video/mp4" and len(r.content) == 112


def test_normalize_keeps_gate_bounds_for_every_scene_count():
    for n in range(6, 11):
        for x in (1, 3, 7, 12, 30):
            out = normalize_seconds([x] * n)
            assert all(3 <= s <= 12 for s in out) and 50 <= sum(out) <= 62


# ---------------------------------------------------------------- what changed (after a live intake)

def _base_of(snap):
    """A previous snapshot with the same workflows and fewer conversations."""
    base = copy.deepcopy(snap)
    base["snapshot_id"] = "snap_20260926T000000_0000"
    added = 0
    for i, c in enumerate(base["clusters"]):
        dec = 0 if c["id"] == "cl_other" else min(int(c["conversations"]) // 3, 5 * (i + 1))
        c["conversations"] = int(c["conversations"]) - dec
        c["friction"] = {**c["friction"], "share": 0.05}
        added += dec
    base["totals"] = {**base["totals"], "conversations": int(snap["totals"]["conversations"]) - added,
                      "friction": {**base["totals"]["friction"], "share": 0.1}}
    return base


def with_change(doc):
    doc = copy.deepcopy(doc)
    doc["scenes"].insert(1, {"type": "change", "seconds": 6,
                             "headline": "{new_conversations} new conversations lift {fastest_growing}"})
    doc["scenes"] = [s for s in doc["scenes"] if s["type"] != "signals"]
    return doc


def test_change_scene_after_intake():
    base = _base_of(SNAP)
    probs, filled = validate(_BriefOut.model_validate(with_change(good())), SNAP, base)
    assert probs == []
    ch = filled["scenes"][1]
    d = ch["data"]
    added = int(SNAP["totals"]["conversations"]) - int(base["totals"]["conversations"])
    assert ch["type"] == "change" and ch["headline"].startswith(f"{added:,} new conversations lift ")
    assert d["added_conversations"] == added and d["base_snapshot_id"] == base["snapshot_id"]
    assert d["items"][0]["after"] - d["items"][0]["before"] == max(x["after"] - x["before"] for x in d["items"])
    assert all(x["id"] != "cl_other" for x in d["items"])
    assert any("previous published snapshot" in c for c in filled["checks"])
    assert serializers.serialize_brief({**_stored_brief(), "scenes": filled["scenes"]})["scenes"][1]["data"]["added_conversations"] == added


def test_change_scene_rules():
    base = _base_of(SNAP)
    # required right after intro when new data arrived
    t = text(validate(_BriefOut.model_validate(good()), SNAP, base)[0])
    assert "change scene is required right after intro" in t
    # not allowed (nor its placeholders) without a previous snapshot
    t = text(check(with_change(good()))[0])
    assert "only allowed when the facts sheet has changes" in t and "placeholders not allowed here" in t


def test_facts_include_changes_only_with_base():
    assert "changes" not in facts(SNAP)
    f = facts(SNAP, _base_of(SNAP))
    assert "(+" in f["changes"]["conversations"] and "new_conversations" in f["placeholders"]
