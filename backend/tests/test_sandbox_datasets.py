"""Seeded unseen-data experiments for the audited fixture programs, not model-quality evidence.

Only the repository's fixed pandas and stdlib programs run locally. Generated/untrusted programs
and containment fixtures must run through the real sandbox, never this test helper.
"""
from fractions import Fraction
import json
import random

import pandas as pd
import pytest

from logless.sandbox import gate
from logless.sandbox.analysis import output_contract
from logless.sandbox.export import COLUMNS, SIGNALS

import oracle
from programs import PANDAS_PROGRAM, STDLIB_PROGRAM, run_locally
from qhelpers import SNAP


def expected(records, clusters, plan):
    """Independent set-based expected result: no shared scope, sorting or counting helpers."""
    categories = {c["id"] for c in clusters if c["level"] == 1 and not c["is_other"]}
    leaves = {c["id"]: c["parent_id"] for c in clusters if c["level"] == 2 and not c["is_other"]
              and c["id"] != "cl_other" and c["parent_id"] in categories
              and (plan["scope_category_id"] is None or c["parent_id"] == plan["scope_category_id"])}
    group_ids = set(leaves) if plan["group_by"] == "leaf" else set(leaves.values())
    bases, counts = {g: set() for g in group_ids}, {g: set() for g in group_ids}
    for row in records:
        if row["leaf_id"] not in leaves:
            continue
        group = row["leaf_id"] if plan["group_by"] == "leaf" else leaves[row["leaf_id"]]
        member = row["row"] if plan["measure"] == "conversations" else row["user"]
        bases[group].add(member)
        signal = plan["signal"]
        observed = signal is None or (any(row[s] == "observed" for s in SIGNALS) if signal == "any_friction"
                                      else row[signal] == "observed")
        if observed:
            counts[group].add(member)
    ranked = []
    for group in group_ids:
        count, base = len(counts[group]), len(bases[group])
        ranked.append({"id": group, "count": count, "base": base,
                       "share": round(count / base, 4) if base else 0.0})
    ranked.sort(key=lambda r: (-(r["count"] if plan["rank_by"] == "count" else
                                Fraction(r["count"], r["base"]) if r["base"] else Fraction(0)), r["id"]))
    return {"intent": "question", "snapshot_id": SNAP, "plan": plan, "rows": ranked[:plan["limit"]],
            "total_count": len(set().union(*counts.values())), "total_base": len(set().union(*bases.values()))}


@pytest.mark.parametrize("case", range(18))
def test_programs_and_gate_on_varied_unseen_datasets(case):
    rng = random.Random(80917 + case)
    categories = [{"id": f"cat_{i:06x}", "parent_id": None, "level": 1, "is_other": False}
                  for i in range(1, rng.randint(1, 3) + 1)]
    leaves = [{"id": f"cl_{i:06x}", "parent_id": rng.choice(categories)["id"], "level": 2, "is_other": False}
              for i in range(1, rng.randint(1, 7) + 1)]
    clusters = categories + leaves + [
        {"id": "cat_ffffff", "parent_id": None, "level": 1, "is_other": True},
        {"id": "cl_other", "parent_id": "cat_ffffff", "level": 2, "is_other": True},
    ]
    rows = []
    # Include empty, all-Other, all-unclear, all-not-observed and all-observed datasets, as well as
    # noisy mixtures. A small shared user pool deliberately repeats people across groups.
    n = 0 if case == 0 else rng.randint(30, 180)
    choices = ["unclear"] if case % 6 == 2 else ["not_observed"] if case % 6 == 3 else \
        ["observed"] if case % 6 == 4 else ["observed", "not_observed", "unclear"]
    for row_id in range(n):
        leaf = clusters[-1] if case % 6 == 1 else rng.choice(leaves + [clusters[-1]])
        rows.append({"row": row_id + 1, "user": rng.randint(1, 5), "leaf_id": leaf["id"],
                     "category_id": leaf["parent_id"], **{s: rng.choice(choices) for s in SIGNALS}})
    group_by = "leaf" if case % 2 == 0 else "category"
    plan = {"group_by": group_by, "scope_category_id": rng.choice(categories)["id"] if case % 4 == 0 else None,
            "scope_leaf_id": None,
            "measure": "people" if case % 3 == 0 else "conversations",
            "signal": [None, "any_friction", *SIGNALS][case % 6],
            "rank_by": "share" if case % 2 == 0 else "count", "limit": [1, 2, 10][case % 3]}
    frame = pd.DataFrame(rows, columns=COLUMNS)
    published = oracle.rounded(oracle.aggregate(frame, clusters, SNAP))
    nodes = {n["id"]: n for n in published["nodes"]}
    want = expected(rows, clusters, plan)
    files = {"assignments.csv": frame.to_csv(index=False), "clusters.json": json.dumps(clusters),
             "contract.json": json.dumps(output_contract(SNAP, plan))}
    results = []
    for code in (PANDAS_PROGRAM, STDLIB_PROGRAM):
        status, output, error = run_locally(code, files)
        assert status == 0, error
        verdict = gate.check_program(output, snapshot_id=SNAP, plan=plan, clusters=clusters,
                                     leaf_ids=[c["id"] for c in clusters if c["level"] == 2],
                                     category_ids=[c["id"] for c in clusters if c["level"] == 1])
        assert verdict.passed, verdict.public()
        assert verdict.canonical == want
        assert all(c.passed for c in gate.check_snapshot(verdict.canonical, plan=plan, clusters=clusters, nodes=nodes))
        results.append(verdict.canonical)
    assert gate.check_agreement(*results).passed
