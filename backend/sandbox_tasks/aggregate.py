"""Sandbox task: snapshot aggregation (pipeline stage 5).

Reads the typed, text-free assignments and writes metrics for the snapshot total, every category
(union of its leaves) and every leaf. Users are distinct per-job pseudonyms per node, never summed.
Output shape and ordering: docs/CONTRACTS.md §8 (aggregate)."""
import json

import pandas as pd

SIGNALS = ["correction", "repeat_request", "assistant_limit", "complaint"]

df = pd.read_csv("/in/assignments.csv", dtype={"leaf_id": str, "category_id": str, **{s: str for s in SIGNALS}})
with open("/in/clusters.json") as f:
    clusters = json.load(f)
with open("/in/contract.json") as f:
    contract = json.load(f)

total = int(len(df))
observed = df[SIGNALS] == "observed"
any_observed = observed.any(axis=1)
unclear = ~any_observed & (df[SIGNALS] == "unclear").any(axis=1)


def metrics(mask):
    n = int(mask.sum())
    fc = int((any_observed & mask).sum())
    return {
        "conversations": n,
        "users": int(df.loc[mask, "user"].nunique()),
        "share": n / total if total else 0.0,
        "friction": {
            "conversations": fc,
            "share": fc / n if n else None,
            "unclear": int((unclear & mask).sum()),
            "signals": {s: int((observed[s] & mask).sum()) for s in SIGNALS},
        },
    }


categories = sorted(c["id"] for c in clusters if c["level"] == 1)
leaves = sorted(c["id"] for c in clusters if c["level"] == 2)
children = {c: [x["id"] for x in clusters if x["level"] == 2 and x["parent_id"] == c] for c in categories}

nodes = [{"id": c, **metrics(df["leaf_id"].isin(children[c]))} for c in categories]
nodes += [{"id": leaf, **metrics(df["leaf_id"] == leaf)} for leaf in leaves]
result = {
    "intent": "aggregate",
    "snapshot_id": contract["snapshot_id"],
    "total_conversations": total,
    "totals": metrics(pd.Series(True, index=df.index)),
    "nodes": nodes,
}
with open("/out/result.json", "w") as f:
    json.dump(result, f)
