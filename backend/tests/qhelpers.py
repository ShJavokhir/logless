"""Shared fixtures for the question tests: a small published structure with an Other category,
random typed inputs, random plans, and the published node metrics for them (computed by the test
oracle, standing in for the pipeline's published snapshot)."""
from __future__ import annotations

import json
import random

import numpy as np
import pandas as pd

import oracle
from logless.sandbox.analysis import output_contract
from logless.sandbox.export import SIGNALS, SandboxInputs, public_structure
from logless.sandbox.plan import Plan

SNAP = "snap_20260926T120000_abcd"
CL = [
    {"id": "cat_aaaaaa", "parent_id": None, "level": 1, "is_other": False},
    {"id": "cat_bbbbbb", "parent_id": None, "level": 1, "is_other": False},
    {"id": "cat_cccccc", "parent_id": None, "level": 1, "is_other": False},
    {"id": "cat_eeeeee", "parent_id": None, "level": 1, "is_other": True},
    {"id": "cl_111111", "parent_id": "cat_aaaaaa", "level": 2, "is_other": False},
    {"id": "cl_222222", "parent_id": "cat_aaaaaa", "level": 2, "is_other": False},
    {"id": "cl_333333", "parent_id": "cat_bbbbbb", "level": 2, "is_other": False},
    {"id": "cl_444444", "parent_id": "cat_bbbbbb", "level": 2, "is_other": False},
    {"id": "cl_555555", "parent_id": "cat_bbbbbb", "level": 2, "is_other": False},
    {"id": "cl_666666", "parent_id": "cat_cccccc", "level": 2, "is_other": False},   # empty in some dfs
    {"id": "cl_other", "parent_id": "cat_eeeeee", "level": 2, "is_other": True},
]
LEAVES = sorted(c["id"] for c in CL if c["level"] == 2)
CATS = sorted(c["id"] for c in CL if c["level"] == 1)
PARENT = {c["id"]: c["parent_id"] for c in CL if c["level"] == 2}
TITLES = {c["id"]: f"Title {c['id']}" for c in CL}
PLAN = {"group_by": "leaf", "scope_category_id": "cat_bbbbbb", "scope_leaf_id": None, "measure": "people", "signal": "repeat_request",
        "rank_by": "share", "limit": 2}


def df_for(seed: int, n: int = 400) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    pool = [x for x in LEAVES if not (seed % 3 == 0 and x == "cl_666666")]
    leaf = rng.choice(pool, size=n)
    df = pd.DataFrame({"row": range(1, n + 1), "user": rng.integers(1, 60, size=n), "leaf_id": leaf,
                       "category_id": [PARENT[x] for x in leaf]})
    for s in SIGNALS:
        df[s] = rng.choice(["observed", "not_observed", "unclear"], size=n, p=[0.25, 0.6, 0.15])
    return df


def random_plan(rng: random.Random) -> dict:
    group_by = rng.choice(["leaf", "category"])
    scope = rng.choice([None, "cat_aaaaaa", "cat_bbbbbb", "cat_cccccc"]) if group_by == "leaf" else None
    return Plan(group_by=group_by, scope_category_id=scope, measure=rng.choice(["conversations", "people"]),
                signal=rng.choice([None, "any_friction", *SIGNALS]), rank_by=rng.choice(["count", "share"]),
                limit=rng.randint(1, 10)).model_dump()


def inputs_for(df: pd.DataFrame) -> SandboxInputs:
    st = public_structure(CL)
    return SandboxInputs(assignments_csv=df.to_csv(index=False), clusters_json=json.dumps(st), df=df, mapping={},
                         clusters=st, leaf_ids=LEAVES, category_ids=CATS)


def files_for(df: pd.DataFrame, plan: dict) -> dict[str, str]:
    return inputs_for(df).files(output_contract(SNAP, plan))


def published_nodes(df: pd.DataFrame) -> dict[str, dict]:
    """What the published snapshot would say about each node (the pipeline's numbers)."""
    agg = oracle.rounded(oracle.aggregate(df, CL, SNAP))
    return {n["id"]: n for n in agg["nodes"]}


def oracle_answer(df: pd.DataFrame, plan: dict) -> dict:
    ref = oracle.question(df, CL, plan, SNAP)
    return oracle.rounded({k: v for k, v in ref.items() if k != "_all"})
