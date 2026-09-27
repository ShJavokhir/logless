"""Trusted reference computations (pure pandas, run in the backend on the exact DataFrame the
sandbox job received). The egress gate compares sandbox output against these, and a passing
result is re-serialized from these values — never from the sandbox bytes.

Definitions (docs/CONTRACTS.md §3, §5, §8):
- a category's metrics are computed over the union of its leaves' conversations;
- users = distinct per-job `user` integers per node, recomputed, never summed;
- friction conversation = at least one signal `observed`; unclear = none observed and >= 1 unclear.
"""
from __future__ import annotations

import pandas as pd

from .export import SIGNALS

SHARE_DP = 4
DEFAULT_OTHER = frozenset({"cl_other"})


def _share(num: int, den: int) -> float:
    return num / den if den else 0.0


def _flags(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    sig = df[list(SIGNALS)]
    observed = (sig == "observed").any(axis=1)
    unclear = (~observed) & (sig == "unclear").any(axis=1)
    return observed, unclear


def usage(df: pd.DataFrame, leaf_ids: list[str], snapshot_id: str, other_ids: frozenset[str] | set[str] = DEFAULT_OTHER) -> dict:
    """Every leaf once, by conversations desc then cluster_id asc; the catch-all leaf is always last."""
    total = int(len(df))
    rows = []
    for leaf in leaf_ids:
        sub = df[df["leaf_id"] == leaf]
        n = int(len(sub))
        rows.append({"cluster_id": leaf, "conversations": n, "users": int(sub["user"].nunique()), "share": _share(n, total)})
    rows.sort(key=lambda r: (r["cluster_id"] in other_ids, -r["conversations"], r["cluster_id"]))
    return {"intent": "usage", "snapshot_id": snapshot_id, "total_conversations": total, "rows": rows}


def friction(df: pd.DataFrame, leaf_ids: list[str], snapshot_id: str, other_ids: frozenset[str] | set[str] = DEFAULT_OTHER) -> dict:
    """Every leaf once, by friction conversations desc then cluster_id asc; the catch-all leaf is always last."""
    total = int(len(df))
    observed, unclear = _flags(df)
    rows = []
    for leaf in leaf_ids:
        m = df["leaf_id"] == leaf
        n = int(m.sum())
        fc = int((observed & m).sum())
        row = {"cluster_id": leaf, "conversations": n, "friction_conversations": fc, "friction_share": _share(fc, n)}
        for s in SIGNALS:
            row[s] = int(((df[s] == "observed") & m).sum())
        row["unclear"] = int((unclear & m).sum())
        rows.append(row)
    rows.sort(key=lambda r: (r["cluster_id"] in other_ids, -r["friction_conversations"], r["cluster_id"]))
    return {"intent": "friction", "snapshot_id": snapshot_id, "total_conversations": total, "rows": rows}


def node_metrics(df: pd.DataFrame, mask: pd.Series, total: int, observed: pd.Series, unclear: pd.Series) -> dict:
    n = int(mask.sum())
    fc = int((observed & mask).sum())
    return {
        "conversations": n,
        "users": int(df.loc[mask, "user"].nunique()),
        "share": _share(n, total),
        "friction": {
            "conversations": fc,
            "share": (fc / n) if n else None,
            "unclear": int((unclear & mask).sum()),
            "signals": {s: int(((df[s] == "observed") & mask).sum()) for s in SIGNALS},
        },
    }


def aggregate(df: pd.DataFrame, clusters: list[dict], snapshot_id: str) -> dict:
    """Metrics (minus languages) for the snapshot total, every category and every leaf.
    Node order: categories by id ascending, then leaves by id ascending."""
    total = int(len(df))
    observed, unclear = _flags(df)
    cats = sorted(c["id"] for c in clusters if int(c["level"]) == 1)
    leaves = sorted(c["id"] for c in clusters if int(c["level"]) == 2)
    children: dict[str, list[str]] = {c: [] for c in cats}
    for c in clusters:
        if int(c["level"]) == 2:
            children[c["parent_id"]].append(c["id"])
    nodes = []
    for cid in cats:
        nodes.append({"id": cid, **node_metrics(df, df["leaf_id"].isin(children[cid]), total, observed, unclear)})
    for lid in leaves:
        nodes.append({"id": lid, **node_metrics(df, df["leaf_id"] == lid, total, observed, unclear)})
    all_rows = pd.Series(True, index=df.index)
    return {"intent": "aggregate", "snapshot_id": snapshot_id, "total_conversations": total,
            "totals": node_metrics(df, all_rows, total, observed, unclear), "nodes": nodes}


def rounded(doc):
    """Canonical form for storage/serving: every share-like float rounded to 4 decimals."""
    if isinstance(doc, dict):
        return {k: rounded(v) for k, v in doc.items()}
    if isinstance(doc, list):
        return [rounded(v) for v in doc]
    if isinstance(doc, float):
        return round(doc, SHARE_DP)
    return doc


# ---------------------------------------------------------------- open questions (docs/CONTRACTS.md §8b)

def question_scope(clusters: list[dict], plan: dict) -> tuple[list[str], set[str]]:
    """(group ids in scope, leaf ids whose rows are in scope). Other or unclear — any is_other
    leaf and any is_other category, plus cl_other — never counts."""
    cats = {c["id"]: c for c in clusters if int(c["level"]) == 1}
    other_cats = {cid for cid, c in cats.items() if c.get("is_other")}
    leaves = [c for c in clusters if int(c["level"]) == 2 and not c.get("is_other") and c["id"] != "cl_other"
              and c.get("parent_id") not in other_cats]
    scope = plan.get("scope_category_id")
    if scope is not None:
        leaves = [c for c in leaves if c["parent_id"] == scope]
    leaf_ids = {c["id"] for c in leaves}
    if plan["group_by"] == "leaf":
        groups = sorted(leaf_ids)
    else:
        groups = sorted(cid for cid in cats if cid not in other_cats and any(c["parent_id"] == cid for c in leaves))
    return groups, leaf_ids


def _signal_mask(df: pd.DataFrame, signal: str | None) -> pd.Series:
    if signal is None:
        return pd.Series(True, index=df.index)
    if signal == "any_friction":
        return (df[list(SIGNALS)] == "observed").any(axis=1)
    return df[signal] == "observed"


def _measure(df: pd.DataFrame, mask: pd.Series, measure: str) -> int:
    return int(mask.sum()) if measure == "conversations" else int(df.loc[mask, "user"].nunique())


def question(df: pd.DataFrame, clusters: list[dict], plan: dict, snapshot_id: str) -> dict:
    """Trusted answer for a validated Plan. Returns the result document (top `limit` rows) plus
    `_all`: every in-scope group's row, which the gate uses for per-id checks."""
    groups, leaf_ids = question_scope(clusters, plan)
    in_scope = df["leaf_id"].isin(leaf_ids)
    sig = _signal_mask(df, plan["signal"])
    key_col = "leaf_id" if plan["group_by"] == "leaf" else "category_id"
    rows = []
    for gid in groups:
        g = in_scope & (df[key_col] == gid)
        count, base = _measure(df, g & sig, plan["measure"]), _measure(df, g, plan["measure"])
        rows.append({"id": gid, "count": count, "base": base, "share": count / base if base else 0.0})
    rows.sort(key=question_sort_key(plan["rank_by"]))
    return {
        "intent": "question", "snapshot_id": snapshot_id, "plan": dict(plan),
        "rows": rows[: plan["limit"]],
        "total_count": _measure(df, in_scope & sig, plan["measure"]),
        "total_base": _measure(df, in_scope, plan["measure"]),
        "_all": rows,
    }


def question_sort_key(rank_by: str):
    """rank_by desc, then id asc. Shares compare as exact fractions, so float rounding can
    never reorder near-ties."""
    from fractions import Fraction
    if rank_by == "count":
        return lambda r: (-r["count"], r["id"])
    return lambda r: (-(Fraction(r["count"], r["base"]) if r["base"] else Fraction(0)), r["id"])
