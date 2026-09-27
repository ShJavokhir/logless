"""Containment fixture: a normal, benign run after the runaway. A small standard-library program
that answers the fixed plan in /in/contract.json (conversations per category, top 5) exactly as
the output contract describes. It must pass the egress gate and the snapshot-consistency checks."""
import csv
import json

SIGNALS = ["correction", "repeat_request", "assistant_limit", "complaint"]
with open("/in/clusters.json") as f:
    clusters = json.load(f)
with open("/in/contract.json") as f:
    contract = json.load(f)
plan = contract["plan"]

other_cats = {c["id"] for c in clusters if c["level"] == 1 and c["is_other"]}
leaves = {c["id"]: c["parent_id"] for c in clusters
          if c["level"] == 2 and not c["is_other"] and c["id"] != "cl_other" and c["parent_id"] not in other_cats}
if plan["scope_category_id"] is not None:
    leaves = {k: v for k, v in leaves.items() if v == plan["scope_category_id"]}
groups = sorted(leaves) if plan["group_by"] == "leaf" else sorted(set(leaves.values()))


def passes(r):
    s = plan["signal"]
    if s is None:
        return True
    if s == "any_friction":
        return any(r[x] == "observed" for x in SIGNALS)
    return r[s] == "observed"


count = {g: set() if plan["measure"] == "people" else 0 for g in groups}
base = {g: set() if plan["measure"] == "people" else 0 for g in groups}
tc, tb = set(), set()
ntc = ntb = 0
with open("/in/assignments.csv", newline="") as f:
    for r in csv.DictReader(f):
        if r["leaf_id"] not in leaves:
            continue
        g = r["leaf_id"] if plan["group_by"] == "leaf" else r["category_id"]
        ok = passes(r)
        if plan["measure"] == "people":
            base[g].add(r["user"])
            tb.add(r["user"])
            if ok:
                count[g].add(r["user"])
                tc.add(r["user"])
        else:
            base[g] += 1
            ntb += 1
            if ok:
                count[g] += 1
                ntc += 1


def size(x):
    return len(x) if isinstance(x, set) else x


rows = [{"id": g, "count": size(count[g]), "base": size(base[g])} for g in groups]
for r in rows:
    r["_s"] = r["count"] / r["base"] if r["base"] else 0.0
key = (lambda r: (-r["count"], r["id"])) if plan["rank_by"] == "count" else (lambda r: (-r["_s"], r["id"]))
rows.sort(key=key)
out = [{"id": r["id"], "count": r["count"], "base": r["base"], "share": round(r["_s"], 4)} for r in rows[: plan["limit"]]]
total_count = len(tc) if plan["measure"] == "people" else ntc
total_base = len(tb) if plan["measure"] == "people" else ntb
with open("/out/result.json", "w") as f:
    json.dump({"intent": "question", "snapshot_id": contract["snapshot_id"], "plan": plan, "rows": out,
               "total_count": total_count, "total_base": total_base}, f)
