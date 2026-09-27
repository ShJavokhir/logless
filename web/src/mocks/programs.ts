// Programs the mock "GLM" writes. They read only the typed assignment files the
// sandbox receives (§7) and write exactly /out/result.json (§8).

export const USAGE_PROGRAM = `"""Usage by workflow cluster.

Reads the per-job assignment table and writes one row per leaf cluster:
conversations, distinct users and share of all conversations.
Ordering rule: conversations desc, then cluster_id asc.
"""
import json

import pandas as pd

with open("/in/contract.json") as f:
    contract = json.load(f)
with open("/in/clusters.json") as f:
    clusters = json.load(f)

df = pd.read_csv("/in/assignments.csv")
leaves = [c["id"] for c in clusters if c["level"] == 2]
total = int(len(df))

by_leaf = (
    df.groupby("leaf_id")
    .agg(conversations=("row", "size"), users=("user", "nunique"))
    .reindex(leaves, fill_value=0)
)

rows = []
for cluster_id, r in by_leaf.iterrows():
    n = int(r["conversations"])
    rows.append({
        "cluster_id": cluster_id,
        "conversations": n,
        "users": int(r["users"]),
        "share": round(n / total, 4) if total else 0.0,
    })

rows.sort(key=lambda r: (-r["conversations"], r["cluster_id"]))

result = {
    "intent": "usage",
    "snapshot_id": contract["snapshot_id"],
    "total_conversations": total,
    "rows": rows,
}

with open("/out/result.json", "w") as f:
    json.dump(result, f, separators=(",", ":"))
`

const FRICTION_BODY = (sortKey: string) => `"""Friction by workflow cluster.

A conversation has friction when at least one signal is "observed".
"unclear" counts conversations with no observed signal and at least one
unclear decision. Signals overlap, so they are counted separately.
Ordering rule: friction_conversations desc, then cluster_id asc.
"""
import json

import pandas as pd

SIGNALS = ["correction", "repeat_request", "assistant_limit", "complaint"]

with open("/in/contract.json") as f:
    contract = json.load(f)
with open("/in/clusters.json") as f:
    clusters = json.load(f)

df = pd.read_csv("/in/assignments.csv")
leaves = [c["id"] for c in clusters if c["level"] == 2]

observed = df[SIGNALS].eq("observed")
unclear = df[SIGNALS].eq("unclear")
df["friction"] = observed.any(axis=1)
df["unclear_only"] = ~df["friction"] & unclear.any(axis=1)
for s in SIGNALS:
    df[s + "_obs"] = observed[s]

agg = {"conversations": ("row", "size"),
       "friction_conversations": ("friction", "sum"),
       "unclear": ("unclear_only", "sum")}
agg.update({s: (s + "_obs", "sum") for s in SIGNALS})
by_leaf = df.groupby("leaf_id").agg(**agg).reindex(leaves, fill_value=0)

rows = []
for cluster_id, r in by_leaf.iterrows():
    n = int(r["conversations"])
    f = int(r["friction_conversations"])
    row = {
        "cluster_id": cluster_id,
        "conversations": n,
        "friction_conversations": f,
        "friction_share": round(f / n, 4) if n else 0.0,
    }
    row.update({s: int(r[s]) for s in SIGNALS})
    row["unclear"] = int(r["unclear"])
    rows.append(row)

${sortKey}

result = {
    "intent": "friction",
    "snapshot_id": contract["snapshot_id"],
    "total_conversations": int(len(df)),
    "rows": rows,
}

with open("/out/result.json", "w") as f:
    json.dump(result, f, separators=(",", ":"))
`

/** First attempt: sorts by share, which the gate rejects (ordering rule). */
export const FRICTION_PROGRAM_ATTEMPT_1 = FRICTION_BODY(
  `rows.sort(key=lambda r: (-r["friction_share"], r["cluster_id"]))`,
)

/** Repaired program after the gate's ordering feedback. */
export const FRICTION_PROGRAM = FRICTION_BODY(
  `# Repair: the contract orders by friction_conversations, not by share.
rows.sort(key=lambda r: (-r["friction_conversations"], r["cluster_id"]))`,
)

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
 * The program the mock "GLM" writes for a validated question plan (§8b). It
 * sees only the plan and file schemas. `buggy` reproduces a classic first
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
  return `"""Answer a validated question plan (the plan contains no data).

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
