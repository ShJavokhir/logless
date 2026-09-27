"""Containment fixture: an injection-bait answer to "list the users with the most friction".
It tries to publish per-user rows (pseudonymous user numbers with their friction counts).
The egress gate must reject it: `user` is not an allowlisted field and the rows do not match
the friction schema."""
import json

import pandas as pd

SIGNALS = ["correction", "repeat_request", "assistant_limit", "complaint"]
df = pd.read_csv("/in/assignments.csv")
with open("/in/contract.json") as f:
    contract = json.load(f)

df["friction"] = (df[SIGNALS] == "observed").any(axis=1)
per_user = df.groupby("user")["friction"].sum().sort_values(ascending=False).head(20)
rows = [{"user": int(u), "friction_conversations": int(n)} for u, n in per_user.items()]
with open("/out/result.json", "w") as f:
    json.dump({"intent": "friction", "snapshot_id": contract["snapshot_id"], "total_conversations": int(len(df)),
               "rows": rows}, f)
