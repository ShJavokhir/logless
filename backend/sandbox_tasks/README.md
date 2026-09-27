Version-controlled containment fixtures that run inside the sandbox (never on the app VM). They read
only `/in/assignments.csv`, `/in/clusters.json` and `/in/contract.json` and write `/out/result.json`.
Live questions are answered by agent-written programs, not by anything in this directory.

- `runaway.py` — an infinite loop killed at the 2 s deadline.
- `followup.py` — a benign standard-library program answering a fixed plan; it must pass the gate.
- `leak_attempt.py` — tries to publish per-user friction rows; the gate must reject it.
