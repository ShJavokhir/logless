"""The egress gate without a runtime reference (docs/CONTRACTS.md §0): per-program checks,
consistency with the published snapshot, agreement of two programs, and the typed export."""
from __future__ import annotations

import copy
import json
import random
import time

import pandas as pd
import pytest

from logless.sandbox import gate
from logless.sandbox.export import frame_from_rows, public_structure

from programs import OFF_BY_ONE_PROGRAM, PANDAS_PROGRAM, STDLIB_PROGRAM, run_locally
from qhelpers import CATS, CL, LEAVES, PLAN, SNAP, df_for, files_for, oracle_answer, published_nodes, random_plan
from sandbox_helpers import CATS as H_CATS, CLUSTERS as H_CLUSTERS, LEAVES as H_LEAVES


def check(text, plan=PLAN):
    return gate.check_program(text if isinstance(text, str) or text is None else json.dumps(text), snapshot_id=SNAP,
                              plan=plan, clusters=public_structure(CL), leaf_ids=LEAVES, category_ids=CATS)


def good(plan=PLAN, seed=5):
    return oracle_answer(df_for(seed), plan)


# ---------------------------------------------------------------- per-program checks

def test_valid_output_passes_and_is_served_canonicalized():
    doc = good()
    doc["rows"][0]["share"] += 0.00004          # within tolerance
    v = check(doc)
    assert v.passed, v.public()
    # served = the program's own numbers, share recomputed from its integers and rounded
    r = doc["rows"][0]
    assert v.canonical["rows"][0] == {"id": r["id"], "count": r["count"], "base": r["base"], "share": round(r["count"] / r["base"], 4)}


@pytest.mark.parametrize("mutate,expected", [
    (lambda d: d["plan"].update(limit=3), gate.C_PLAN),
    (lambda d: d["plan"].pop("signal"), gate.C_PLAN),
    (lambda d: d["rows"][0].update(id="cl_111111"), gate.C_SCOPE),                  # outside the scoped category
    (lambda d: d["rows"].append({"id": "cl_other", "count": 1, "base": 1, "share": 1.0}), gate.C_SCOPE),
    (lambda d: d["rows"].append(dict(d["rows"][0])), gate.C_SCOPE),                 # duplicate id
    (lambda d: d["rows"].pop(), gate.C_LENGTH),
    (lambda d: d["rows"].reverse(), gate.C_ORDER),
    (lambda d: d["rows"][0].update(count=d["rows"][0]["base"] + 1), gate.C_ARITH),
    (lambda d: d["rows"][0].update(share=0.99), gate.C_ARITH),
    (lambda d: d["rows"][0].update(count=-1), gate.C_NONNEG),
    (lambda d: d.update(total_count=d["total_base"] + 1), gate.C_TOTALS),
    (lambda d: d["rows"][0].update(user=17), gate.C_FIELDS),
    (lambda d: d["rows"][0].update(id="people who ask about divorce"), gate.C_STRINGS),
    (lambda d: d.update(snapshot_id="snap_20200101T000000_ffff"), gate.C_SNAPSHOT),
    (lambda d: d["rows"][0].update(count=True), gate.C_SCHEMA),
    (lambda d: d.update(note="hello"), gate.C_FIELDS),
])
def test_program_rejections(mutate, expected):
    doc = copy.deepcopy(good())
    mutate(doc)
    v = check(doc)
    assert not v.passed and expected in v.failed_names, v.failed_names
    text = json.dumps(v.public())
    assert "divorce" not in text and "hello" not in text and "snap_20200101" not in text


def test_other_category_never_in_scope():
    plan = {"group_by": "category", "scope_category_id": None, "measure": "conversations", "signal": None,
            "rank_by": "count", "limit": 10}
    doc = good(plan)
    assert "cat_eeeeee" not in [r["id"] for r in doc["rows"]]
    doc["rows"][-1]["id"] = "cat_eeeeee"
    assert gate.C_SCOPE in check(doc, plan).failed_names


@pytest.mark.parametrize("text,detail", [
    ('{"intent": "question", "intent": "question"}', "duplicate key"),
    ('{"x": NaN}', "NaN"),
    ('{"x": 1e999}', "out of range"),
    ('[1, 2]', "not a JSON object"),
    ('{"a": 1} {"b": 2}', "not a single valid JSON document"),
])
def test_strict_parse(text, detail):
    v = check(text)
    assert v.failed_names == [gate.C_PARSE] and detail in v.checks[-1].detail


def test_no_output_and_oversize():
    assert [c.name for c in check(None).checks] == [gate.C_OUTPUT]
    v = check(json.dumps(good()) + " " * (1024 * 1024))
    assert v.failed_names == [gate.C_SIZE]


def test_deeply_nested_output_is_rejected_cheaply():
    inner = json.dumps(["x" * 900] * 900)
    text = '{"rows": ' + '{"a": ' * 850 + inner + "}" * 850 + "}"
    assert len(text) < 1024 * 1024
    t0 = time.monotonic()
    v = check(text)
    assert time.monotonic() - t0 < 1.0 and not v.passed
    assert v.failed_names in (["Strict JSON parse"], [gate.C_SHAPE])
    assert len(json.dumps(v.public())) < 2000


def test_diagnostics_are_bounded():
    doc = good()
    doc["rows"] = [{"id": f"cl_{i:06x}", "count": 1, "base": 1, "share": 1.0, f"x{i}": 1} for i in range(1000)]
    v = check(doc)
    for c in v.checks:
        assert len(c.detail) < 400
    assert "(+997 more)" in next(c for c in v.checks if c.name == gate.C_FIELDS).detail


# ---------------------------------------------------------------- consistency with the published snapshot

BASE_C = "Consistent with the published map · base = published conversations"
BASE_P = "Consistent with the published map · base = published people"
TOTAL = "Consistent with the published map · totals = published scope totals"
RANKING = "Consistent with the published map · top groups = published ranking"


def _snap_checks(doc, plan, df):
    v = check(doc, plan)
    assert v.passed, v.failed_names
    return {c.name: c for c in gate.check_snapshot(v.canonical, plan=plan, clusters=public_structure(CL), nodes=published_nodes(df))}


def test_consistency_checks_apply_where_derivable():
    df = df_for(4)
    conv = {"group_by": "category", "scope_category_id": None, "measure": "conversations", "signal": "complaint",
            "rank_by": "count", "limit": 10}
    got = _snap_checks(oracle_answer(df, conv), conv, df)
    assert set(got) == {BASE_C, "Consistent with the published map · count = published complaint conversations", TOTAL, RANKING} \
        and all(c.passed for c in got.values())
    people = {"group_by": "leaf", "scope_category_id": "cat_bbbbbb", "measure": "people", "signal": "complaint",
              "rank_by": "count", "limit": 10}
    got = _snap_checks(oracle_answer(df, people), people, df)
    # people per signal are not published: only bases and the scoped category's people are checkable
    assert set(got) == {BASE_P, TOTAL} and all(c.passed for c in got.values())
    whole = dict(people, scope_category_id=None)
    assert set(_snap_checks(oracle_answer(df, whole), whole, df)) == {BASE_P}


def test_off_by_one_program_fails_consistency_not_the_program_checks():
    df = df_for(8)
    plan = {"group_by": "leaf", "scope_category_id": None, "measure": "conversations", "signal": "any_friction",
            "rank_by": "count", "limit": 5}
    rc, out, _ = run_locally(OFF_BY_ONE_PROGRAM, files_for(df, plan))
    assert rc == 0
    v = check(out, plan)
    assert v.passed   # internally consistent on its own ...
    snap = gate.check_snapshot(v.canonical, plan=plan, clusters=public_structure(CL), nodes=published_nodes(df))
    failed = [c for c in snap if not c.passed]
    assert {c.name for c in failed} == {BASE_C}   # ... but not with the published map
    assert "rows[0].base differs from the published conversations" in next(c.detail for c in failed if c.name == BASE_C)


# ---------------------------------------------------------------- agreement

def test_agreement():
    a = gate.canonicalize(good())
    assert gate.check_agreement(a, copy.deepcopy(a)).passed
    b = copy.deepcopy(a)
    b["rows"][1]["count"] += 1
    b["total_base"] += 1
    c = gate.check_agreement(a, b)
    assert not c.passed and c.detail == "Programs disagree on row 1 · count; Programs disagree on total_base"


def test_both_fixture_programs_pass_and_agree_for_random_plans():
    """Property test: the hand-written pandas (A) and stdlib (B) stand-ins for the GLM programs pass
    every per-program and consistency check, agree exactly, and match the test oracle."""
    rng = random.Random(20260927)
    for i in range(10):
        df, plan = df_for(200 + i), random_plan(rng)
        outs = {}
        for name, code in (("A", PANDAS_PROGRAM), ("B", STDLIB_PROGRAM)):
            rc, out, err = run_locally(code, files_for(df, plan))
            assert rc == 0, err
            v = check(out, plan)
            assert v.passed, (name, plan, v.failed_names)
            snap = gate.check_snapshot(v.canonical, plan=plan, clusters=public_structure(CL), nodes=published_nodes(df))
            assert all(c.passed for c in snap), (name, plan, [c.name for c in snap if not c.passed])
            outs[name] = v.canonical
        assert gate.check_agreement(outs["A"], outs["B"]).passed, plan
        assert outs["A"] == oracle_answer(df, plan), plan


# ---------------------------------------------------------------- export (typed, text-free inputs)

def test_frame_from_rows_pseudonymizes_and_maps_themes():
    rows = pd.DataFrame({
        "conv_id": [f"c_{i:012x}" for i in range(6)],
        "user_id": ["u_a", "u_a", "u_b", "u_c", "u_c", "u_c"],
        "theme_id": ["t1", "t2", "t3", "t4", "other", "t_unknown"],
        "correction": ["observed", None, "unclear", "not_observed", "bogus", "observed"],
    })
    df, mapping = frame_from_rows(rows, H_CLUSTERS)
    assert list(df.columns) == ["row", "user", "leaf_id", "category_id", "correction", "repeat_request", "assistant_limit", "complaint"]
    assert sorted(df["row"]) == [1, 2, 3, 4, 5, 6] and df["user"].nunique() == 3
    by_conv = {mapping["row"][r]: rec for r, rec in zip(df["row"], df.to_dict("records"))}
    assert by_conv["c_000000000000"]["leaf_id"] == "cl_111111" and by_conv["c_000000000000"]["category_id"] == "cat_aaaaaa"
    assert by_conv["c_000000000005"]["leaf_id"] == "cl_other"          # unmapped theme -> catch-all
    assert by_conv["c_000000000001"]["correction"] == "unclear"        # missing decision
    assert by_conv["c_000000000004"]["correction"] == "unclear"        # invalid value
    csv = df.to_csv(index=False)
    assert "c_" not in csv and "u_" not in csv
    assert [c["id"] for c in public_structure(H_CLUSTERS)] == H_CATS + H_LEAVES
    assert all("theme_ids" not in c for c in public_structure(H_CLUSTERS))


def test_pseudonyms_are_fresh_per_export():
    rows = pd.DataFrame({"conv_id": [f"c_{i}" for i in range(50)], "user_id": [f"u_{i % 7}" for i in range(50)],
                         "theme_id": ["t1"] * 50})
    _, ma = frame_from_rows(rows, H_CLUSTERS)
    _, mb = frame_from_rows(rows, H_CLUSTERS)
    assert ma["row"] != mb["row"]
