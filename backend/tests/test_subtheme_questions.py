"""Open questions over the third map level: sub-themes as level-3 nodes in clusters.json, a
subtheme_id column in assignments.csv, group_by "subtheme" / scope_leaf_id in the Plan, and the
gate's published-map cross-checks against the per-sub-theme counts."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest
from pydantic import ValidationError

import oracle
from logless.api import serializers
from logless.sandbox import analysis, export, gate
from logless.sandbox.export import SIGNALS, SandboxInputs, public_structure
from logless.sandbox.plan import Plan, plan_text, question_scope, sanitize_question, semantic_problems
from logless.sandbox.runs import Run, load

from programs import LocalRunner, run_locally
from qhelpers import CATS, CL, LEAVES, SNAP, TITLES, df_for
from sandbox_helpers import tmp_data  # noqa: F401
from test_question import FakeGLM

SUBS = {
    "cl_111111": ["cl_111111_s1", "cl_111111_s2"],
    "cl_333333": ["cl_333333_s1", "cl_333333_s2", "cl_333333_rest"],
    "cl_444444": ["cl_444444_s1", "cl_444444_s2"],
}
SUB_NODES = [{"id": s, "parent_id": lid, "level": 3, "is_other": s.endswith("_rest")} for lid, ss in SUBS.items() for s in ss]
CL_SUB = public_structure(CL + SUB_NODES)
SUB_TITLES = {**TITLES, **{s: f"Sub {s}" for ss in SUBS.values() for s in ss}}
BASE = {"group_by": "subtheme", "scope_category_id": None, "scope_leaf_id": None, "measure": "conversations",
        "signal": None, "rank_by": "count", "limit": 10}


def df_sub(seed: int, n: int = 500) -> pd.DataFrame:
    """df_for rows plus a subtheme_id: one of the leaf's sub-themes, or empty (rows the sub-themes don't cover)."""
    df = df_for(seed, n)
    rng = np.random.default_rng(seed + 1)
    df.insert(4, "subtheme_id", [rng.choice(SUBS[leaf] + [""]) if leaf in SUBS else "" for leaf in df["leaf_id"]])
    return df


def inputs_sub(df: pd.DataFrame) -> SandboxInputs:
    return SandboxInputs(assignments_csv=df.to_csv(index=False), clusters_json=json.dumps(CL_SUB), df=df, mapping={},
                         clusters=CL_SUB, leaf_ids=LEAVES, category_ids=CATS,
                         subtheme_ids=sorted(c["id"] for c in SUB_NODES))


def published(df: pd.DataFrame) -> dict[str, dict]:
    """Snapshot nodes plus what GET /api/subthemes publishes per sub-theme (conversations, users)."""
    nodes = {n["id"]: n for n in oracle.rounded(oracle.aggregate(df, CL, SNAP))["nodes"]}
    for c in SUB_NODES:
        m = df["subtheme_id"] == c["id"]
        nodes[c["id"]] = {"id": c["id"], "level": 3, "conversations": int(m.sum()), "users": int(df.loc[m, "user"].nunique())}
    return nodes


def answer(df: pd.DataFrame, plan: dict) -> dict:
    ref = oracle.question(df, CL_SUB, plan, SNAP)
    return oracle.rounded({k: v for k, v in ref.items() if k != "_all"})


# Stand-ins for the GLM-written programs, written from the data dictionary and RULES only.
PANDAS_SUB = r'''
import json
import pandas as pd
S = ["correction", "repeat_request", "assistant_limit", "complaint"]
df = pd.read_csv("/in/assignments.csv", dtype=str, keep_default_na=False)
clusters = json.load(open("/in/clusters.json")); contract = json.load(open("/in/contract.json")); plan = contract["plan"]
other_cats = {c["id"] for c in clusters if c["level"] == 1 and c["is_other"]}
leaves = {c["id"]: c["parent_id"] for c in clusters if c["level"] == 2 and not c["is_other"] and c["id"] != "cl_other" and c["parent_id"] not in other_cats}
if plan["scope_category_id"] is not None: leaves = {k: v for k, v in leaves.items() if v == plan["scope_category_id"]}
if plan["scope_leaf_id"] is not None: leaves = {k: v for k, v in leaves.items() if k == plan["scope_leaf_id"]}
sc = df[df["leaf_id"].isin(set(leaves))]
if plan["group_by"] == "subtheme":
    groups = sorted(c["id"] for c in clusters if c["level"] == 3 and not c["is_other"] and c["parent_id"] in leaves)
    sc = sc[sc["subtheme_id"].isin(set(groups))]; col = "subtheme_id"
elif plan["group_by"] == "leaf": groups, col = sorted(leaves), "leaf_id"
else: groups, col = sorted(set(leaves.values())), "category_id"
if plan["signal"] is None: m = pd.Series(True, index=sc.index)
elif plan["signal"] == "any_friction": m = (sc[S] == "observed").any(axis=1)
else: m = sc[plan["signal"]] == "observed"
meas = (lambda x: int(len(x))) if plan["measure"] == "conversations" else (lambda x: int(x["user"].nunique()))
rows = []
for g in groups:
    gg = sc[sc[col] == g]
    c, b = meas(gg[m.loc[gg.index]]), meas(gg)
    rows.append({"id": g, "count": c, "base": b, "share": (c / b) if b else 0.0})
if plan["rank_by"] == "count": rows.sort(key=lambda r: (-r["count"], r["id"]))
else: rows.sort(key=lambda r: (-r["share"], r["id"]))
rows = rows[: plan["limit"]]
for r in rows: r["share"] = round(r["share"], 4)
json.dump({"intent": "question", "snapshot_id": contract["snapshot_id"], "plan": plan, "rows": rows,
           "total_count": meas(sc[m]), "total_base": meas(sc)}, open("/out/result.json", "w"))
'''

STDLIB_SUB = r'''
import csv
import json
S = ["correction", "repeat_request", "assistant_limit", "complaint"]
clusters = json.load(open("/in/clusters.json")); contract = json.load(open("/in/contract.json")); plan = contract["plan"]
other_cats = {c["id"] for c in clusters if c["level"] == 1 and c["is_other"]}
leaves = {c["id"]: c["parent_id"] for c in clusters if c["level"] == 2 and not c["is_other"] and c["id"] != "cl_other" and c["parent_id"] not in other_cats}
if plan["scope_category_id"] is not None: leaves = {k: v for k, v in leaves.items() if v == plan["scope_category_id"]}
if plan["scope_leaf_id"] is not None: leaves = {k: v for k, v in leaves.items() if k == plan["scope_leaf_id"]}
subs = {c["id"] for c in clusters if c["level"] == 3 and not c["is_other"] and c["parent_id"] in leaves}
groups = {"leaf": sorted(leaves), "category": sorted(set(leaves.values())), "subtheme": sorted(subs)}[plan["group_by"]]
people = plan["measure"] == "people"
count = {g: set() for g in groups}; base = {g: set() for g in groups}; tc, tb = set(), set()
for r in csv.DictReader(open("/in/assignments.csv", newline="")):
    if r["leaf_id"] not in leaves or (plan["group_by"] == "subtheme" and r["subtheme_id"] not in subs):
        continue
    g = {"leaf": r["leaf_id"], "category": r["category_id"], "subtheme": r["subtheme_id"]}[plan["group_by"]]
    s = plan["signal"]
    ok = s is None or (any(r[x] == "observed" for x in S) if s == "any_friction" else r[s] == "observed")
    key = r["user"] if people else r["row"]
    base[g].add(key); tb.add(key)
    if ok:
        count[g].add(key); tc.add(key)
rows = [{"id": g, "count": len(count[g]), "base": len(base[g])} for g in groups]
for r in rows: r["_s"] = r["count"] / r["base"] if r["base"] else 0.0
rows.sort(key=(lambda r: (-r["count"], r["id"])) if plan["rank_by"] == "count" else (lambda r: (-r["_s"], r["id"])))
out = [{"id": r["id"], "count": r["count"], "base": r["base"], "share": round(r["_s"], 4)} for r in rows[: plan["limit"]]]
json.dump({"intent": "question", "snapshot_id": contract["snapshot_id"], "plan": plan, "rows": out,
           "total_count": len(tc), "total_base": len(tb)}, open("/out/result.json", "w"))
'''


def check(output: str, plan: dict) -> gate.Verdict:
    return gate.check_program(output, snapshot_id=SNAP, plan=plan, clusters=CL_SUB, leaf_ids=LEAVES, category_ids=CATS)


# ---------------------------------------------------------------- plan vocabulary

def test_plan_accepts_subtheme_scopes_and_rejects_bad_combinations():
    Plan.model_validate({**BASE, "scope_leaf_id": "cl_333333"})
    Plan.model_validate({**BASE, "scope_category_id": "cat_bbbbbb"})
    Plan.model_validate({**BASE, "group_by": "leaf", "scope_category_id": "cat_bbbbbb"})
    for bad in [{"group_by": "leaf", "scope_leaf_id": "cl_333333"},
                {"group_by": "category", "scope_category_id": "cat_bbbbbb"},
                {"scope_leaf_id": "cl_333333", "scope_category_id": "cat_bbbbbb"},
                {"scope_leaf_id": "cl_other"}, {"scope_leaf_id": "cl_333333_s1"}]:
        with pytest.raises(ValidationError):
            Plan.model_validate({**BASE, **bad})
    # plans written before scope_leaf_id existed still validate, with the key filled in
    old = {k: v for k, v in BASE.items() if k != "scope_leaf_id"} | {"group_by": "leaf"}
    assert Plan.model_validate(old).model_dump()["scope_leaf_id"] is None
    assert analysis.output_contract(SNAP, old)["plan"]["scope_leaf_id"] is None


def test_question_scope_excludes_the_remainder_and_follows_the_scope():
    assert question_scope(CL_SUB, BASE)[0] == ["cl_111111_s1", "cl_111111_s2", "cl_333333_s1", "cl_333333_s2",
                                                "cl_444444_s1", "cl_444444_s2"]
    assert question_scope(CL_SUB, {**BASE, "scope_leaf_id": "cl_333333"}) == (["cl_333333_s1", "cl_333333_s2"], {"cl_333333"})
    assert question_scope(CL_SUB, {**BASE, "scope_category_id": "cat_aaaaaa"})[0] == ["cl_111111_s1", "cl_111111_s2"]
    # leaf and category plans ignore level 3 entirely
    assert question_scope(CL_SUB, {**BASE, "group_by": "leaf"}) == question_scope(public_structure(CL), {**BASE, "group_by": "leaf"})


def test_semantic_problems_for_subtheme_plans():
    assert semantic_problems(Plan(**{**BASE, "scope_leaf_id": "cl_333333"}), CL_SUB) == []
    assert semantic_problems(Plan(**{**BASE, "scope_leaf_id": "cl_999999"}), CL_SUB) == ["scope_leaf_id is not a published workflow"]
    assert any("no sub-themes" in p for p in semantic_problems(Plan(**{**BASE, "scope_leaf_id": "cl_555555"}), CL_SUB))
    assert any("no sub-themes" in p for p in semantic_problems(Plan(**BASE), public_structure(CL)))


def test_plan_text_names_the_workflow_scope():
    assert plan_text({**BASE, "scope_leaf_id": "cl_333333"}, SUB_TITLES) == \
        "Conversations · within Title cl_333333 · by sub-theme · top 10 by count"


# ---------------------------------------------------------------- export

def test_frame_keeps_a_subtheme_only_inside_its_own_leaf():
    clusters = [{"id": "cat_aaaaaa", "parent_id": None, "level": 1, "is_other": False},
                {"id": "cl_111111", "parent_id": "cat_aaaaaa", "level": 2, "is_other": False, "theme_ids": ["t1"]},
                {"id": "cl_222222", "parent_id": "cat_aaaaaa", "level": 2, "is_other": False, "theme_ids": ["t2"]}]
    subs = export.subtheme_nodes([c for c in clusters if c["level"] == 2],
                                 {"leaves": {"cl_111111": [{"id": "cl_111111_s1"}, {"id": "cl_111111_rest", "rest": True}],
                                             "cl_999999": [{"id": "cl_999999_s1"}]}})
    assert subs == [{"id": "cl_111111_s1", "parent_id": "cl_111111", "level": 3, "is_other": False},
                    {"id": "cl_111111_rest", "parent_id": "cl_111111", "level": 3, "is_other": True}]
    rows = pd.DataFrame({"conv_id": ["c1", "c2", "c3", "c4"], "user_id": ["u1", "u1", "u2", "u3"],
                         "theme_id": ["t1", "t1", "t2", "t1"], **{s: ["observed"] * 4 for s in SIGNALS}})
    member = {"c1": "cl_111111_s1", "c2": "cl_111111_rest", "c3": "cl_111111_s1"}   # c3 is in another leaf
    df, mapping = export.frame_from_rows(rows, clusters, subtheme_of=member, subthemes=subs)
    got = {mapping["row"][r]: s for r, s in zip(df["row"], df["subtheme_id"])}
    assert got == {"c1": "cl_111111_s1", "c2": "cl_111111_rest", "c3": "", "c4": ""}
    assert list(df.columns) == export.COLUMNS


def test_export_adds_level_three_nodes_from_the_stored_subthemes(monkeypatch):
    from logless.pipeline import subthemes
    clusters = [{**c, "theme_ids": [f"t_{c['id']}"]} if c["level"] == 2 else c for c in CL]
    rows = pd.DataFrame({"conv_id": ["c1", "c2"], "user_id": ["u1", "u2"], "theme_id": ["t_cl_333333", "t_cl_111111"],
                         **{s: ["not_observed"] * 2 for s in SIGNALS}})
    monkeypatch.setattr(export, "_load_frozen", lambda sid: rows)
    doc = {"leaves": {lid: [{"id": s, "rest": s.endswith("_rest")} for s in ss] for lid, ss in SUBS.items()}}
    monkeypatch.setattr(subthemes, "load_for_build", lambda b: doc)
    monkeypatch.setattr(subthemes, "load_members", lambda b: {"c1": "cl_333333_s2"})
    inp = export.export_inputs("build", clusters, snapshot_id=SNAP)
    assert [c for c in inp.clusters if c["level"] == 3] == sorted(SUB_NODES, key=lambda c: c["id"])
    assert inp.subtheme_ids == sorted(c["id"] for c in SUB_NODES)
    assert sorted(inp.df["subtheme_id"]) == ["", "cl_333333_s2"]
    # stored sub-themes without stored membership: no level 3 at all rather than a column of blanks
    monkeypatch.setattr(subthemes, "load_members", lambda b: {})
    inp = export.export_inputs("build", clusters, snapshot_id=SNAP)
    assert not [c for c in inp.clusters if c["level"] == 3] and set(inp.df["subtheme_id"]) == {""}


# ---------------------------------------------------------------- programs, gate and published-map checks

@pytest.mark.parametrize("plan", [
    BASE,
    {**BASE, "scope_leaf_id": "cl_333333", "signal": "complaint", "rank_by": "share"},
    {**BASE, "scope_category_id": "cat_bbbbbb", "measure": "people", "signal": "any_friction", "limit": 3},
    {**BASE, "measure": "people", "limit": 2},
])
def test_both_programs_pass_the_gate_and_the_published_subtheme_counts(plan):
    df = df_sub(4)
    files = inputs_sub(df).files(analysis.output_contract(SNAP, plan))
    results = []
    for code in (PANDAS_SUB, STDLIB_SUB):
        status, output, err = run_locally(code, files)
        assert status == 0, err
        v = check(output, plan)
        assert v.passed, v.failed_names
        assert v.canonical == answer(df, plan)
        maps = gate.check_snapshot(v.canonical, plan=plan, clusters=CL_SUB, nodes=published(df))
        assert maps and all(c.passed for c in maps), [c.name for c in maps if not c.passed]
        results.append(v.canonical)
    assert gate.check_agreement(*results).passed
    # neither remainder rows nor rows without a sub-theme count toward the totals
    in_groups = df["subtheme_id"].isin(question_scope(CL_SUB, plan)[0])
    if plan["measure"] == "conversations":
        assert results[0]["total_base"] == int(in_groups.sum()) < int(df["leaf_id"].isin(question_scope(CL_SUB, plan)[1]).sum())


def test_gate_rejects_a_remainder_row_and_a_base_that_disagrees_with_the_map():
    df = df_sub(5)
    plan = {**BASE, "scope_leaf_id": "cl_333333"}
    doc = answer(df, plan)
    bad = json.loads(json.dumps(doc))
    bad["rows"][0]["id"] = "cl_333333_rest"
    assert gate.C_SCOPE in check(json.dumps(bad), plan).failed_names
    nodes = published(df)
    nodes["cl_333333_s1"] = {**nodes["cl_333333_s1"], "conversations": nodes["cl_333333_s1"]["conversations"] + 1}
    v = check(json.dumps(doc), plan)
    failed = [c.name for c in gate.check_snapshot(v.canonical, plan=plan, clusters=CL_SUB, nodes=nodes) if not c.passed]
    assert failed[:2] == [gate.map_check_name(x) for x in ("base = published conversations", "totals = published scope totals")]


def test_a_subtheme_question_runs_end_to_end(tmp_data, monkeypatch):
    from logless.providers import glm
    plan = {**BASE, "scope_leaf_id": "cl_333333", "signal": "any_friction", "limit": 5}
    fake = FakeGLM({"plan": plan}, a=(PANDAS_SUB,), b=(STDLIB_SUB,))
    monkeypatch.setattr(glm, "chat", fake.chat)
    monkeypatch.setattr(glm, "chat_json", fake.chat_json)
    df = df_sub(6)
    q = "Which part of Title cl_333333 has the most friction?"
    run = Run.create("analysis", "question", SNAP, question=sanitize_question(q))
    analysis.run_analysis(run, snapshot_id=SNAP, titles=SUB_TITLES, nodes=published(df), question=q,
                          runner=LocalRunner(), inputs=inputs_sub(df))
    d = load(run.id)
    assert d["state"] == "completed", d["error"]
    assert d["result"] == answer(df, plan) and d["verdict"]["passed"]
    assert {r["id"] for r in d["result"]["rows"]} <= {"cl_333333_s1", "cl_333333_s2"}
    # the interpreting model sees each workflow's sub-themes (never the remainder) nested under it
    prompt = next(t for k, t in fake.prompts if k == "Interpretation")
    payload = json.loads(prompt[prompt.index('{"question"'):])
    wf = {w["id"]: w for w in payload["workflows"]}
    assert wf["cl_333333"]["sub_themes"] == [{"id": "cl_333333_s1", "title": "Sub cl_333333_s1"},
                                             {"id": "cl_333333_s2", "title": "Sub cl_333333_s2"}]
    assert "sub_themes" not in wf["cl_555555"]
    # the program prompt documents the new column and level
    code_prompt = next(t for k, t in fake.prompts if k == "code:A")
    assert "subtheme_id" in code_prompt and "level-3 sub-theme" in code_prompt


def test_serializer_passes_subtheme_rows_and_plans():
    plan = {**BASE, "scope_leaf_id": "cl_333333"}
    res = {"intent": "question", "snapshot_id": SNAP, "plan": plan,
           "rows": [{"id": "cl_333333_s1", "count": 3, "base": 5, "share": 0.6}], "total_count": 3, "total_base": 5}
    got = serializers._result(res)
    assert got["plan"] == plan and got["rows"][0]["id"] == "cl_333333_s1"
    with pytest.raises(serializers.Blocked):
        serializers._plan({**plan, "scope_leaf_id": "cl_333333_s1"})


def test_membership_round_trips_per_build(tmp_data):
    from logless.pipeline import subthemes
    n = subthemes.save_members("b1", {"cl_333333": {"cl_333333_s1": ["c1", "c2"], "cl_333333_rest": ["c3"]}})
    subthemes.save_members("b2", {"cl_111111": {"cl_111111_s1": ["c9"]}})
    assert n == 3 and subthemes.load_members("b1") == {"c1": "cl_333333_s1", "c2": "cl_333333_s1", "c3": "cl_333333_rest"}
    subthemes.save_members("b1", {"cl_333333": {"cl_333333_s2": ["c1"]}})   # replaces, never merges
    assert subthemes.load_members("b1") == {"c1": "cl_333333_s2"} and subthemes.load_members("b2") == {"c9": "cl_111111_s1"}
