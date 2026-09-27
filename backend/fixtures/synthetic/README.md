# Synthetic assistant corpus

These are **fictional** conversations, not customer data. The files stay outside all browser assets and API routes.

- `conversations.jsonl`: 600 conversations, 150 fictional users, 28 days. Messages and structured tool events are the only map inputs.
- `manifest.json`: actual counts, dates, and SHA-256 of the committed JSONL.
- `expected.jsonl`: generator expectations, evaluated separately. Never an inference input.
- `classifier-cases.json`: nine focused, authored abstractions for a live Jev rubric probe. The probe's two-theme taxonomy is an evaluation fixture, not a claimed discovery output.

Regenerate with `backend/.venv/bin/python -m logless.synthetic seed` from the repository root.
The recipe is `backend/logless/synthetic/seed.py`. It includes changing preferences, explicit corrections,
task complaints, life complaints, failed actions, recovered failures, uncertain completion, quiet endings,
and an unknown goal. Distinctive fictional canaries and instruction-like text test generalization.
