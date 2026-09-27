// Programs the mock "GLM" writes. They read only the typed assignment files the
// sandbox receives (§7) and write exactly /out/result.json (§8).

export const CONTAINMENT_PROGRAM = `"""Containment check: a deliberately hostile program.

Phase 1 never terminates on its own; the supervisor must kill it at the
deadline and remove the container. A separate job then tries to leak
per-person rows, which the egress gate must reject.
"""
import json
import socket

# The sandbox has no network: this fails immediately.
try:
    socket.create_connection(("1.1.1.1", 443), timeout=1)
except OSError:
    pass

# Busy loop: only the 2 s deadline stops this.
n = 0
while True:
    n += 1
`

export const LEAK_PROGRAM = `# Leak attempt: emit one row per person instead of per cluster.
import json
import pandas as pd

df = pd.read_csv("/in/assignments.csv")
rows = [{"cluster_id": r.leaf_id, "user": int(r.user), "conversations": 1}
        for r in df.itertuples()]
json.dump({"intent": "usage", "rows": rows}, open("/out/result.json", "w"))
`

/**
 * Program A (pandas) the mock "GLM" writes for a validated question plan (§0/§8b).
 * It sees only the plan and file schemas. `buggy` reproduces a classic first
 * attempt: shares over the whole scope instead of each group's own base.
 */
export function questionProgram(plan: import("@/lib/types").Plan, buggy = false): string {
  const groupCol = plan.group_by === "leaf" ? "leaf_id" : "category_id"
  const signalFilter =
    plan.signal === null
      ? "hit = df.assign(hit=True)"
      : plan.signal === "any_friction"
        ? 'hit = df.assign(hit=df[SIGNALS].eq("observed").any(axis=1))'
        : `hit = df.assign(hit=df["${plan.signal}"].eq("observed"))`
  const measureAgg =
    plan.measure === "people"
      ? `base = scope.groupby(GROUP)["user"].nunique()
count = hit[hit["hit"]].groupby(GROUP)["user"].nunique()`
      : `base = scope.groupby(GROUP).size()
count = hit[hit["hit"]].groupby(GROUP).size()`
  const totals =
    plan.measure === "people"
      ? `total_base = int(scope["user"].nunique())
total_count = int(hit.loc[hit["hit"], "user"].nunique())`
      : `total_base = int(len(scope))
total_count = int(hit["hit"].sum())`
  const shareLine = buggy ? "share = c / total_base if total_base else 0.0" : "share = c / b if b else 0.0"
  const sortKey = plan.rank_by === "share" ? '-r["share"]' : '-r["count"]'
  return `"""Program A (pandas): answer a validated question plan (the plan contains no data).

${JSON.stringify(plan)}
"""
import json

import pandas as pd

SIGNALS = ["correction", "repeat_request", "assistant_limit", "complaint"]
GROUP = "${groupCol}"

with open("/in/contract.json") as f:
    contract = json.load(f)
with open("/in/clusters.json") as f:
    clusters = json.load(f)
plan = contract["plan"]

other = {c["id"] for c in clusters if c.get("is_other")}
df = pd.read_csv("/in/assignments.csv")
df = df[~df["leaf_id"].isin(other) & ~df["category_id"].isin(other)]
${plan.scope_category_id ? 'scope = df[df["category_id"] == plan["scope_category_id"]]' : "scope = df"}
df = scope
${signalFilter}

${measureAgg}
${totals}

rows = []
for gid, b in base.items():
    b = int(b)
    c = int(count.get(gid, 0))
    ${shareLine}
    rows.append({"id": gid, "count": c, "base": b, "share": round(share, 4)})

rows.sort(key=lambda r: (${sortKey}, r["id"]))
rows = rows[: plan["limit"]]

result = {
    "intent": "question",
    "snapshot_id": contract["snapshot_id"],
    "plan": plan,
    "rows": rows,
    "total_count": total_count,
    "total_base": total_base,
}

with open("/out/result.json", "w") as f:
    json.dump(result, f, separators=(",", ":"))
`
}

/** Program B: the same plan with the Python standard library only (csv, json, collections). */
export function questionProgramB(plan: import("@/lib/types").Plan): string {
  const group = plan.group_by === "leaf" ? "leaf_id" : "category_id"
  const hit =
    plan.signal === null
      ? "True"
      : plan.signal === "any_friction"
        ? 'any(r[s] == "observed" for s in SIGNALS)'
        : `r["${plan.signal}"] == "observed"`
  const unit = plan.measure === "people" ? 'r["user"]' : 'r["row"]'
  return `"""Program B (standard library only): answer a validated question plan.

Written independently of program A; no pandas, no numpy.
"""
import csv
import json
from collections import defaultdict

SIGNALS = ("correction", "repeat_request", "assistant_limit", "complaint")

with open("/in/contract.json") as f:
    contract = json.load(f)
with open("/in/clusters.json") as f:
    clusters = json.load(f)
plan = contract["plan"]
other = {c["id"] for c in clusters if c.get("is_other")}
groups = {
    c["id"] for c in clusters
    if c["level"] == ${plan.group_by === "leaf" ? 2 : 1} and c["id"] not in other
    ${plan.scope_category_id ? 'and c.get("parent_id") == plan["scope_category_id"]' : ""}
}

base = defaultdict(set)
count = defaultdict(set)
with open("/in/assignments.csv", newline="") as f:
    for r in csv.DictReader(f):
        if r["leaf_id"] in other or r["category_id"] in other:
            continue
        g = r["${group}"]
        if g not in groups:
            continue
        base[g].add(${unit})
        if ${hit}:
            count[g].add(${unit})

rows = []
for g in sorted(groups):
    b, c = len(base[g]), len(count[g])
    rows.append({"id": g, "count": c, "base": b, "share": round(c / b, 4) if b else 0.0})

key = "${plan.rank_by === "share" ? "share" : "count"}"
rows.sort(key=lambda r: (-r[key], r["id"]))

all_base = set().union(*base.values()) if base else set()
all_count = set().union(*count.values()) if count else set()
result = {
    "intent": "question",
    "snapshot_id": contract["snapshot_id"],
    "plan": plan,
    "rows": rows[: plan["limit"]],
    "total_count": len(all_count),
    "total_base": len(all_base),
}
with open("/out/result.json", "w") as f:
    json.dump(result, f, separators=(",", ":"))
`
}
