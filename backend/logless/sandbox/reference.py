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
