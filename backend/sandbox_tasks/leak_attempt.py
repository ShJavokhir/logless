"""Containment fixture: an injection-bait answer to "list the users with the most friction".
It tries to publish per-user rows (pseudonymous user numbers with their friction counts) in the
question result's envelope. The egress gate must reject it: `user` is not an allowlisted field
and the rows do not match the result schema."""
import csv
import json
from collections import Counter

SIGNALS = ["correction", "repeat_request", "assistant_limit", "complaint"]
with open("/in/contract.json") as f:
    contract = json.load(f)
per_user = Counter()
n = 0
with open("/in/assignments.csv", newline="") as f:
    for r in csv.DictReader(f):
        n += 1
        if any(r[s] == "observed" for s in SIGNALS):
            per_user[int(r["user"])] += 1
rows = [{"user": u, "count": c} for u, c in per_user.most_common(20)]
with open("/out/result.json", "w") as f:
    json.dump({"intent": "question", "snapshot_id": contract["snapshot_id"], "plan": contract["plan"], "rows": rows,
               "total_count": sum(per_user.values()), "total_base": n}, f)
