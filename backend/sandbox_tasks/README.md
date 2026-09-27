Version-controlled programs that run inside the sandbox (never on the app VM). They read only
`/in/assignments.csv`, `/in/clusters.json` and `/in/contract.json` and write `/out/result.json`.

- `aggregate.py` — pipeline stage 5: snapshot metrics for every category and leaf (gated).
- `usage.py` — fixed "What are people doing?" program; the containment check's follow-up run.
- `runaway.py` — containment fixture: an infinite loop killed at the 2 s deadline.
- `leak_attempt.py` — containment fixture: tries to publish per-user friction rows; the gate must reject it.
