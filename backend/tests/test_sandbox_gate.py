"""Egress gate + trusted reference tests."""
from __future__ import annotations

import copy
import json

import pandas as pd
import pytest

from logless.sandbox import gate, reference
from logless.sandbox.export import frame_from_rows, public_structure

from sandbox_helpers import CATS, CLUSTERS, LEAVES, SNAP, dumps, make_df


def run_gate(doc_or_text, intent="usage", df=None):
    df = make_df() if df is None else df
    ref = {"usage": reference.usage, "friction": reference.friction}[intent](df, LEAVES, SNAP) if intent != "aggregate" \
        else reference.aggregate(df, CLUSTERS, SNAP)
    text = doc_or_text if isinstance(doc_or_text, str) or doc_or_text is None else dumps(doc_or_text)
    return gate.check(text, intent=intent, snapshot_id=SNAP, leaf_ids=LEAVES, category_ids=CATS, reference=ref), ref


def good(intent="usage", df=None):
    df = make_df() if df is None else df
    if intent == "usage":
        doc = reference.usage(df, LEAVES, SNAP)
    elif intent == "friction":
        doc = reference.friction(df, LEAVES, SNAP)
    else:
        doc = reference.aggregate(df, CLUSTERS, SNAP)
    return reference.rounded(doc)


def failed(v):
    return set(v.failed_names)


# ---------------------------------------------------------------- passing results

@pytest.mark.parametrize("intent", ["usage", "friction", "aggregate"])
def test_valid_result_passes_and_canonical_is_reference(intent):
    v, ref = run_gate(good(intent), intent)
    assert v.passed, v.public()
    assert v.canonical == reference.rounded(ref)
    assert all(c.passed for c in v.checks)
    names = [c.name for c in v.checks]
    assert gate.C_COUNTS in names and gate.C_ORDER[intent] in names


def test_canonical_never_uses_sandbox_floats():
    doc = good()
    doc["rows"][0]["share"] = doc["rows"][0]["share"] + 0.00004  # within tolerance, but not the reference value
    v, ref = run_gate(doc)
    assert v.passed
    assert v.canonical["rows"][0]["share"] == round(ref["rows"][0]["share"], 4)


# ---------------------------------------------------------------- rejections

def test_fabricated_cluster_id_rejected():
    doc = good()
    doc["rows"][1]["cluster_id"] = "cl_999999"
    v, _ = run_gate(doc)
    assert not v.passed
    assert {gate.C_STRINGS, gate.C_IDS, gate.C_COVERAGE} <= failed(v)
    assert "cl_999999" not in json.dumps(v.public())


def test_category_id_in_usage_rows_rejected():
    doc = good()
    doc["rows"][0]["cluster_id"] = "cat_aaaaaa"
    v, _ = run_gate(doc)
    assert gate.C_IDS in failed(v) and gate.C_STRINGS not in failed(v)


def test_wrong_count_rejected():
    doc = good()
    doc["rows"][2]["users"] += 1
    v, _ = run_gate(doc)
    assert failed(v) == {gate.C_COUNTS}
    assert "rows[2].users differs" in next(c.detail for c in v.checks if c.name == gate.C_COUNTS)


def test_wrong_total_rejected():
    doc = good()
    doc["total_conversations"] += 3
    v, _ = run_gate(doc)
    assert gate.C_TOTAL in failed(v)


def test_wrong_order_rejected():
    doc = good()
    doc["rows"][0], doc["rows"][1] = doc["rows"][1], doc["rows"][0]
    v, _ = run_gate(doc)
    assert failed(v) == {gate.C_ORDER["usage"]}


def test_friction_order_rule():
    doc = good("friction")
    doc["rows"].reverse()
    v, _ = run_gate(doc, "friction")
    assert gate.C_ORDER["friction"] in failed(v)


def test_cross_snapshot_id_rejected():
    doc = good()
    doc["snapshot_id"] = "snap_20260101T000000_ffff"
    v, _ = run_gate(doc)
    assert {gate.C_SNAPSHOT, gate.C_STRINGS} <= failed(v)
    assert "snap_20260101" not in json.dumps(v.public())


def test_extra_field_user_rejected():
    doc = good()
    for i, r in enumerate(doc["rows"]):
        r["user"] = i + 1
    v, _ = run_gate(doc)
    assert {gate.C_FIELDS, gate.C_SCHEMA} <= failed(v)
    detail = next(c.detail for c in v.checks if c.name == gate.C_FIELDS)
    assert "unknown field 'user' in rows[0]" in detail


def test_unknown_field_name_is_not_echoed():
    doc = good()
    doc["rows"][0]["alice_smith_42"] = 1
    v, _ = run_gate(doc)
    assert gate.C_FIELDS in failed(v)
    assert "alice" not in json.dumps(v.public())


def test_free_text_string_rejected():
    doc = good()
    doc["rows"][0]["cluster_id"] = "people who ask about their divorce"
    doc["note"] = "hello"
    v, _ = run_gate(doc)
    assert {gate.C_STRINGS, gate.C_FIELDS} <= failed(v)
    assert "divorce" not in json.dumps(v.public()) and "hello" not in json.dumps(v.public())


def test_float_drift_rejected():
    doc = good()
    doc["rows"][0]["share"] += 0.0003
    v, _ = run_gate(doc)
    assert failed(v) == {gate.C_SHARES}


def test_oversize_document_rejected():
    text = json.dumps(good()) + " " * (1024 * 1024)
    v, _ = run_gate(text)
    assert failed(v) == {gate.C_SIZE}
    assert [c.name for c in v.checks] == [gate.C_OUTPUT, gate.C_SIZE]


@pytest.mark.parametrize("text,detail", [
    ('{"intent": "usage", "intent": "usage"}', "duplicate key"),
    ('{"intent": NaN}', "NaN"),
    ('{"x": 1e999}', "out of range"),
    ('[1, 2]', "not a JSON object"),
    ('{"a": 1} {"b": 2}', "not a single valid JSON document"),
    ('[' * 100000 + ']' * 100000, ""),
])
def test_strict_parse(text, detail):
    v, _ = run_gate(text)
    assert failed(v) == {gate.C_PARSE}
    assert detail in v.checks[-1].detail


def test_booleans_and_floats_as_integers_rejected():
    doc = good()
    doc["rows"][0]["conversations"] = True
    doc["rows"][1]["users"] = float(doc["rows"][1]["users"])
    v, _ = run_gate(doc)
    assert gate.C_SCHEMA in failed(v)


def test_negative_integer_rejected():
    doc = good()
    doc["rows"][-1]["users"] = -1
    v, _ = run_gate(doc)
    assert gate.C_NONNEG in failed(v)


def test_missing_and_duplicate_leaf_rejected():
    doc = good()
    doc["rows"][-1] = copy.deepcopy(doc["rows"][0])
    v, _ = run_gate(doc)
    assert gate.C_COVERAGE in failed(v)
    assert "1 missing, 1 duplicated" in next(c.detail for c in v.checks if c.name == gate.C_COVERAGE)


def test_no_output():
    v, _ = run_gate(None)
    assert [c.name for c in v.checks] == [gate.C_OUTPUT] and not v.passed


def test_aggregate_rejects_tampered_category_users():
    doc = good("aggregate")
    doc["nodes"][0]["users"] += 5
    v, _ = run_gate(doc, "aggregate")
    assert failed(v) == {gate.C_COUNTS}


# ---------------------------------------------------------------- reference

def test_reference_categories_are_unions_and_users_not_summed():
    df = make_df(n=300, users=20)
    agg = reference.aggregate(df, CLUSTERS, SNAP)
    nodes = {n["id"]: n for n in agg["nodes"]}
    for cat in CATS:
        leaves = [c["id"] for c in CLUSTERS if c.get("parent_id") == cat]
        assert nodes[cat]["conversations"] == sum(nodes[x]["conversations"] for x in leaves)
        # distinct users over the union — with 20 users spread across leaves, summing would overcount
        assert nodes[cat]["users"] == df[df.leaf_id.isin(leaves)]["user"].nunique()
        assert nodes[cat]["users"] < sum(nodes[x]["users"] for x in leaves)
        assert nodes[cat]["friction"]["conversations"] == sum(nodes[x]["friction"]["conversations"] for x in leaves)
    assert agg["totals"]["conversations"] == len(df) == sum(nodes[x]["conversations"] for x in LEAVES)
    assert agg["totals"]["users"] == df["user"].nunique()
    assert [n["id"] for n in agg["nodes"]] == CATS + LEAVES


def test_reference_friction_definitions():
    df = pd.DataFrame([
        {"row": 1, "user": 1, "leaf_id": "cl_111111", "category_id": "cat_aaaaaa", "correction": "observed", "repeat_request": "observed", "assistant_limit": "not_observed", "complaint": "unclear"},
        {"row": 2, "user": 1, "leaf_id": "cl_111111", "category_id": "cat_aaaaaa", "correction": "unclear", "repeat_request": "not_observed", "assistant_limit": "not_observed", "complaint": "not_observed"},
        {"row": 3, "user": 2, "leaf_id": "cl_111111", "category_id": "cat_aaaaaa", "correction": "not_observed", "repeat_request": "not_observed", "assistant_limit": "not_observed", "complaint": "not_observed"},
    ])
    fr = reference.friction(df, LEAVES, SNAP)
    row = next(r for r in fr["rows"] if r["cluster_id"] == "cl_111111")
    assert row["friction_conversations"] == 1 and row["unclear"] == 1   # signals overlap, never summed
    assert row["correction"] == 1 and row["repeat_request"] == 1 and row["complaint"] == 0
    empty = next(r for r in fr["rows"] if r["cluster_id"] == "cl_222222")
    assert empty["conversations"] == 0 and empty["friction_share"] == 0.0
    agg = reference.aggregate(df, CLUSTERS, SNAP)
    assert next(n for n in agg["nodes"] if n["id"] == "cl_222222")["friction"]["share"] is None


# ---------------------------------------------------------------- export

def test_frame_from_rows_pseudonymizes_and_maps_themes():
    rows = pd.DataFrame({
        "conv_id": [f"c_{i:012x}" for i in range(6)],
        "user_id": ["u_a", "u_a", "u_b", "u_c", "u_c", "u_c"],
        "theme_id": ["t1", "t2", "t3", "t4", "other", "t_unknown"],
        "correction": ["observed", None, "unclear", "not_observed", "bogus", "observed"],
    })
    df, mapping = frame_from_rows(rows, CLUSTERS)
    assert list(df.columns) == ["row", "user", "leaf_id", "category_id", "correction", "repeat_request", "assistant_limit", "complaint"]
    assert sorted(df["row"]) == [1, 2, 3, 4, 5, 6] and df["user"].nunique() == 3
    assert df["row"].is_monotonic_increasing
    by_conv = {mapping["row"][r]: rec for r, rec in zip(df["row"], df.to_dict("records"))}
    assert by_conv["c_000000000000"]["leaf_id"] == "cl_111111" and by_conv["c_000000000000"]["category_id"] == "cat_aaaaaa"
    assert by_conv["c_000000000005"]["leaf_id"] == "cl_other"          # unmapped theme -> catch-all
    assert by_conv["c_000000000001"]["correction"] == "unclear"        # missing decision
    assert by_conv["c_000000000004"]["correction"] == "unclear"        # invalid value
    assert by_conv["c_000000000000"]["repeat_request"] == "unclear"    # no column at all
    csv = df.to_csv(index=False)
    assert "c_" not in csv and "u_" not in csv
    assert [c["id"] for c in public_structure(CLUSTERS)] == CATS + LEAVES
    assert all("theme_ids" not in c for c in public_structure(CLUSTERS))


def test_pseudonyms_are_fresh_per_export():
    rows = pd.DataFrame({"conv_id": [f"c_{i}" for i in range(50)], "user_id": [f"u_{i % 7}" for i in range(50)],
                         "theme_id": ["t1"] * 50})
    a, ma = frame_from_rows(rows, CLUSTERS)
    b, mb = frame_from_rows(rows, CLUSTERS)
    assert ma["row"] != mb["row"]
