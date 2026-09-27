# Built during the hackathon

All code in this repository was written during the Vultr Agent Arena, which ran from Sat 2026-09-26 11:30 to Sun 2026-09-27 12:00 PDT. The git history and each snapshot's provenance timestamps record when.

**Before the start:** the notes in `research/` were written on the morning of Sep 26, 10:06–10:24 PDT, before hacking began at 11:30. They cover the rules, the platform, and sandbox options. They contain no code, and they aren't part of the product. The product spec (`docs/SPEC_SNAPSHOT_2026-09-26.md`) was written during the event, before coding began.

## New code (written this weekend)

| Area | Paths |
|---|---|
| Pipeline: facets, discovery, classification, leftovers, hierarchy, descriptions, privacy gate, publish | `backend/logless/pipeline/` |
| Provider clients: Vultr Serverless Inference (GLM), TypeSafe Jev, Fireworks embeddings | `backend/logless/providers/` |
| Sandbox clean room: export, trusted reference, egress gate, live-analysis loop, containment | `backend/logless/sandbox/`, `backend/sandbox_tasks/` |
| Web API, allowlist serializers, leak checks, rate limiting, stories, search | `backend/logless/api/` |
| Evaluation: reference-set scoring, external-label agreement, ablation, leak scans | `backend/logless/eval/` |
| Sandbox runner service | `runner/` |
| Web app | `web/src/` |
| Infrastructure: provisioning, VM setup, lockdown, deploy | `infra/` |
| Contracts and spec | `docs/` |


## Reused libraries (unmodified, installed from package registries)

- **Backend:** FastAPI, Uvicorn, Pydantic, httpx, NumPy, pandas, PyArrow, scikit-learn, python-dotenv, pytest.
- **Frontend:** React, Vite, TypeScript, Tailwind CSS, shadcn/ui (Radix primitives), lucide-react, d3-hierarchy, Geist fonts, Vitest.
- **Infrastructure:** Docker Engine, gVisor (`runsc`), Caddy, Ubuntu 24.04 on Vultr.

## Data origins

- **Input:** [allenai/WildChat-1M](https://huggingface.co/datasets/allenai/WildChat-1M), revision `7d6490e`, shard 0. A seeded sample of 5,000 conversations. ODC-BY 1.0; de-identified by the dataset authors. Not redistributed here: `logless seed` downloads it.
- **Evaluation fixtures:** 40 canary and 10 injection-bait conversations, synthetic and written for this project (`backend/logless/data/fixtures.py`).
- **Reference labels:** friction labels for 200 sampled conversations, made this weekend by two independent model labellers (`backend/logless/eval/gold/`). External labels joined from Microsoft WildFeedback (ODC-By) and sh0416/wildchat-1m-tagged (ODC-By) (`backend/logless/eval/external/`).

## Hosted services used

- **Vultr:** Serverless Inference (GLM 5.3) and compute (2 VMs, VPC).
- **TypeSafe:** Jev.
- **Fireworks:** embeddings.
