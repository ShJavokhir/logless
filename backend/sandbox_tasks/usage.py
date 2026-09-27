"""Sandbox task: fixed "What are people doing?" program (used as the containment follow-up run).
Every leaf exactly once, ordered by conversations desc, then cluster_id asc; the catch-all leaf
(is_other) is always last."""
import json

import pandas as pd

df = pd.read_csv("/in/assignments.csv", dtype={"leaf_id": str, "category_id": str})
with open("/in/clusters.json") as f:
    clusters = json.load(f)
with open("/in/contract.json") as f:
    contract = json.load(f)

total = int(len(df))
other = {c["id"] for c in clusters if c["level"] == 2 and c.get("is_other")}
rows = []
for leaf in sorted(c["id"] for c in clusters if c["level"] == 2):
    sub = df[df["leaf_id"] == leaf]
    n = int(len(sub))
    rows.append({"cluster_id": leaf, "conversations": n, "users": int(sub["user"].nunique()),
                 "share": round(n / total, 4) if total else 0.0})
rows.sort(key=lambda r: (r["cluster_id"] in other, -r["conversations"], r["cluster_id"]))
with open("/out/result.json", "w") as f:
    json.dump({"intent": "usage", "snapshot_id": contract["snapshot_id"], "total_conversations": total, "rows": rows}, f)
