"""Allowlist serializers and story validation."""
from __future__ import annotations

import copy
import json

import pytest

from logless.api import leakcheck, serializers, stories
from logless.api.stories import _StoryOut

from sandbox_helpers import tmp_data  # noqa: F401

SNAP = "snap_20260926T120000_abcd"
PRIVATE_KEYS = {"conv_id": "c_0123456789ab", "user_id": "u_0123456789", "source_text": "user: my name is Alice and my email is a@b.co",
                "conversation": "user: hi Alice",
                "stderr_tail": "Traceback: KeyError 'c_0123456789ab'", "facet_text": "private facet", "theme_ids": ["t1"],
                "build_id": "b_20260926T120000", "mapping": {"1": "c_0123456789ab"}}


def metrics(n=10):
    return {"conversations": n, "users": 4, "share": 0.123456, "friction": {"conversations": 2, "share": 0.2, "unclear": 1,
            "signals": {"correction": 1, "repeat_request": 1, "assistant_limit": 0, "complaint": 0}},
            "languages": [{"name": "English", "conversations": n}]}


def snapshot():
    leaf = {**metrics(), "id": "cl_1a2b3c", "level": 2, "parent_id": "cat_aaaaaa", "title": "Planning trips",
            "description": "People plan trips.", "needs": [{"id": "n1", "text": "Draft an itinerary"}],
            "problems": [{"id": "p1", "text": "No live prices", "signal": "assistant_limit", "support": "common"}],
            "surprising": {"flag": False, "score": 0.1}, "is_other": False}
    cat = {**metrics(), "id": "cat_aaaaaa", "level": 1, "parent_id": None, "title": "Everyday", "description": "Everyday things.",
           "children": ["cl_1a2b3c"]}
    return {"snapshot_id": SNAP, "created_at": "2026-09-26T12:00:00Z",
            "workspace": {"name": "Muse", "description": "demo"},
            "dataset": {"name": "WildChat-1M", "source_url": "https://huggingface.co/datasets/allenai/WildChat-1M", "revision": "7d64",
                        "license": "ODC-BY-1.0", "attribution": "Zhao et al.", "period_start": "2023-04-08", "period_end": "2023-05-04",
                        "conversations": 10, "users": 4, "languages": 1, "sample_note": "sample", "fixtures": {"canary_conversations": 40}},
            "totals": metrics(), "categories": [cat], "clusters": [leaf], "intended_uses": ["writing"],
            "provenance": {"pipeline_version": "0.1.0", "dataset_hash": "abc", "models": {"facets": "glm-5.3-flash"},
                           "prompt_versions": {"facets": "v1"}, "discovery_rounds": 2, "build_seconds": 12.5,
                           "stages": [{"stage": "facets", "started_at": "a", "finished_at": "b", "counts": {"n": 1}, "models": ["glm"]}]}}


def run_doc():
    return {"run_id": "run_0123456789ab", "kind": "analysis", "intent": "usage", "snapshot_id": SNAP, "state": "completed",
            "created_at": "t0", "updated_at": "t1",
            "stages": [{"name": "planning", "status": "done", "started_at": "t0", "finished_at": "t1", "detail": "ok"}],
            "attempts": 1, "code": "print(1)\n",
            "receipt": {"job_id": "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f", "runtime": "runsc", "image": "logless-analysis:1",
                        "code_sha256": "ab" * 32, "exit_code": 0, "elapsed_ms": 10,
                        "timed_out": False, "output_bytes": 5, "container_removed": True,
                        "limits": {"cpus": 1, "memory_mb": 512, "pids": 64, "timeout_s": 10, "network": "none", "read_only_root": True},
                        "started_at": "2026-09-27T01:00:00.000Z", "finished_at": "2026-09-27T01:00:00.010Z", "host": "logless-sandbox"},
            "verdict": {"passed": True, "checks": [{"name": "Schema matches exactly", "passed": True, "detail": "ok"}]},
            "result": {"intent": "usage", "snapshot_id": SNAP, "total_conversations": 10,
                       "rows": [{"cluster_id": "cl_1a2b3c", "conversations": 10, "users": 4, "share": 1.0}]},
            "explanation": {"text": "{{rows.0.cluster_id}} leads.", "metric_refs": ["rows.0.cluster_id"]},
            "containment": None, "error": None}


FREE_FORM = {"models", "prompt_versions", "counts"}   # Record<string, …> maps in the contract


def inject(doc, depth=0):
    """Add private-looking keys at every fixed-shape dict level."""
    if isinstance(doc, dict):
        for k, v in list(doc.items()):
            if k not in FREE_FORM:
                inject(v, depth + 1)
        doc.update(copy.deepcopy(PRIVATE_KEYS))
    elif isinstance(doc, list):
        for v in doc:
            inject(v, depth + 1)
    return doc


def assert_clean(out):
    text = json.dumps(out)
    for k in PRIVATE_KEYS:
        assert f'"{k}"' not in text, k
    assert "c_0123456789ab" not in text and "u_0123456789" not in text and "Alice" not in text and "Traceback" not in text


def test_snapshot_serializer_drops_private_fields(tmp_data):
    out = serializers.serialize_snapshot(inject(snapshot()))
    assert_clean(out)
    assert out["clusters"][0]["share"] == 0.1235 and out["clusters"][0]["friction"]["share"] == 0.2
    assert "children" in out["categories"][0] and "needs" not in out["categories"][0]
    assert out["clusters"][0]["problems"][0] == {"id": "p1", "text": "No live prices", "signal": "assistant_limit", "support": "common"}


def test_run_serializer_drops_private_fields():
    raw = inject(run_doc())
    raw["receipt"]["output"] = '{"secret": 1}'
    out = serializers.serialize_run(raw)
    assert_clean(out)
    assert out["explanation"] == {"text": "{{rows.0.cluster_id}} leads.", "metric_refs": ["rows.0.cluster_id"]}
    assert "output" not in out["receipt"] and out["result"]["rows"][0] == {"cluster_id": "cl_1a2b3c", "conversations": 10, "users": 4, "share": 1.0}


def test_story_and_eval_serializers_drop_private_fields(tmp_data):
    story = {"cluster_id": "cl_1a2b3c", "snapshot_id": SNAP, "label": stories.LABEL, "first_name": "Maya",
             "text": "Maya wants help [n1].", "citations": ["n1"], "model": "glm-5.3", "generated_at": "t"}
    assert_clean(serializers.serialize_story(inject(story)))
    rep = {"snapshot_id": SNAP, "generated_at": "t", "checks": [{"id": "recall", "name": "Recall", "value": "0.9", "target": ">=0.8",
                                                                 "passed": True, "detail": "ok"}]}
    assert_clean(serializers.serialize_eval(inject(rep)))


@pytest.mark.parametrize("path,value", [
    (("clusters", 0, "id"), "c_0123456789ab"),          # private id in an id field
    (("snapshot_id",), "snap_bad"),
    (("clusters", 0, "needs", 0, "id"), "x1"),
    (("totals", "users"), -1),
    (("totals", "users"), True),
])
def test_snapshot_serializer_rejects_bad_ids_and_numbers(tmp_data, path, value):
    doc = snapshot()
    ref = doc
    for p in path[:-1]:
        ref = ref[p]
    ref[path[-1]] = value
    with pytest.raises(serializers.Blocked):
        serializers.serialize_snapshot(doc)


def test_free_form_maps_keep_simple_entries_but_block_private_ids(tmp_data):
    doc = snapshot()
    doc["provenance"]["models"]["weird"] = ["list"]
    doc["provenance"]["stages"][0]["counts"]["Bad Key"] = 3
    out = serializers.serialize_snapshot(doc)
    assert "weird" not in out["provenance"]["models"] and "Bad Key" not in out["provenance"]["stages"][0]["counts"]
    doc["provenance"]["models"]["conv"] = "c_0123456789ab"
    with pytest.raises(serializers.Blocked):
        serializers.serialize_snapshot(doc)


def test_snapshot_with_private_id_in_text_is_blocked(tmp_data):
    doc = snapshot()
    doc["clusters"][0]["description"] = "Seen in c_0123456789ab."
    with pytest.raises(serializers.Blocked):
        serializers.serialize_snapshot(doc)


def test_snapshot_with_canary_is_blocked(tmp_data):
    from logless import db
    con = db.private()
    with db.write(con):
        con.execute("INSERT INTO eval_fixtures(conv_id, kind, tokens_json) VALUES ('c_x','canary',?)", (json.dumps(["Quixby Tarnwell"]),))
    leakcheck.reset_cache()
    doc = snapshot()
    doc["clusters"][0]["needs"][0]["text"] = "Help quixby tarnwell plan"
    with pytest.raises(serializers.Blocked):
        serializers.serialize_snapshot(doc)
    leakcheck.reset_cache()


# ---------------------------------------------------------------- story validation

NODE = {"id": "cl_1a2b3c", "title": "Planning trips", "description": "People plan trips.",
        "needs": [{"id": "n1", "text": "Draft an itinerary"}, {"id": "n2", "text": "Compare options"}],
        "problems": [{"id": "p1", "text": "No live prices", "signal": "assistant_limit", "support": "common"}]}
GOOD = ("Maya is planning a long weekend away with friends and wants the assistant to sketch a simple itinerary she can "
        "share with the group [n1]. She asks it to compare a few options that fit a modest budget, weighing travel time "
        "against how much they would actually get to see [n2]. The first drafts are useful, and she likes how quickly the "
        "structure comes together. Her frustration starts when she asks what things cost right now: the assistant cannot "
        "look up live prices or availability, so she has to check every suggestion somewhere else before the plan feels "
        "real [p1]. She keeps using it for the outline and the comparisons, but treats every detail about prices as a "
        "guess until she has confirmed it herself.")


def story(text=GOOD, name="Maya", cites=("n1", "n2", "p1")):
    return _StoryOut(first_name=name, text=text, citations=list(cites))


def test_story_validator_accepts_good_story(tmp_data):
    probs, cleaned = stories.validate(story(), NODE)
    assert probs == [], probs
    assert cleaned["citations"] == ["n1", "n2", "p1"]


@pytest.mark.parametrize("mutate,expect", [
    (lambda t: t.replace("[p1]", "[p7]"), "do not exist"),
    (lambda t: " ".join(t.split()[:60]), "length"),
    (lambda t: t + " " + t, "length"),
    (lambda t: t.replace("a long weekend", "a 3 day weekend"), "digits"),
    (lambda t: t.replace("with friends", "with friends as a nurse"), "occupations"),
    (lambda t: t.replace("away with friends", "in Paris with friends"), "places"),
    (lambda t: t.replace("with friends", "with friends, maya@example.com"), "contact"),
    (lambda t: t.replace("the group", "the group, most users agree"), "statistics"),
    (lambda t: t.replace("She asks", "Diagnosed with anxiety, she asks"), "medical"),
    (lambda t: t.replace("with friends", "at forty years old with friends"), "ages"),
    (lambda t: t.replace("[n1]", "").replace("[n2]", "").replace("[p1]", ""), "cite"),
])
def test_story_validator_rejects(tmp_data, mutate, expect):
    probs, _ = stories.validate(story(mutate(GOOD)), NODE)
    assert any(expect in p for p in probs), probs


def test_story_validator_name_and_no_problem_clusters(tmp_data):
    assert any("first name" in p for p in stories.validate(story(name="Dr Maya"), NODE)[0])
    node = {**NODE, "problems": []}
    text = GOOD.replace("[p1]", "[n1]")
    assert any("no specific frustration" in p for p in stories.validate(story(text, cites=["n1", "n2"]), node)[0]) is False  # mentions "frustration"
    text2 = text.replace("Her frustration starts", "Things change")
    assert any("no specific frustration" in p for p in stories.validate(story(text2, cites=["n1", "n2"]), node)[0])


def test_story_validator_blocks_canary(tmp_data):
    from logless import db
    con = db.private()
    with db.write(con):
        con.execute("INSERT INTO eval_fixtures(conv_id, kind, tokens_json) VALUES ('c_y','canary',?)", (json.dumps(["Quillon"]),))
    leakcheck.reset_cache()
    probs, _ = stories.validate(story(GOOD.replace("Maya", "Quillon"), name="Quillon"), NODE)
    assert any("identifiers" in p for p in probs)
    leakcheck.reset_cache()


def test_cluster_input_is_published_fields_only():
    node = {**inject(copy.deepcopy({**NODE, **metrics()}))}
    ci = stories.cluster_input(node)
    assert_clean(ci)
    assert set(ci) == {"title", "description", "needs", "problems", "metrics"}


def test_digit_only_canaries_do_not_block_structured_payloads(tmp_data):
    from logless import db
    con = db.private()
    with db.write(con):
        con.execute("INSERT INTO eval_fixtures(conv_id, kind, tokens_json) VALUES ('c_z','canary',?)", (json.dumps(["4155550199"]),))
    leakcheck.reset_cache()
    doc = snapshot()
    doc["provenance"]["dataset_hash"] = "ab4155550199cd"          # accidental digit run inside a hash
    serializers.serialize_snapshot(doc)                            # served
    doc["clusters"][0]["needs"][0]["text"] = "Call 4155550199 later"
    with pytest.raises(serializers.Blocked):                       # but never inside published text
        serializers.serialize_snapshot(doc)
    leakcheck.reset_cache()
