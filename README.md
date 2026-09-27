# logless

**What are people doing with our assistant, and what isn't working for them? logless answers both without anyone reading a conversation.**

logless is an open, Clio-style usage-insights tool for teams that build chat assistants. An agent pipeline turns private conversations into a published map of workflows. Each workflow shows its size, how many distinct people it covers, friction signals, and generalized needs and problems. Every number is computed by code that runs in an isolated gVisor sandbox on a separate machine with no credentials, and an egress gate checks each number against a trusted reference.

- **Live demo:** https://144-202-110-2.sslip.io
- **Data:** a fixed sample of 5,000 real conversations from [WildChat-1M](https://huggingface.co/datasets/allenai/WildChat-1M) (Zhao et al., ICLR 2024, ODC-BY). That is April–May 2023, 2,790 people (hashed IPs) and 55 languages, plus 50 planted evaluation fixtures.
- **Built for** the Vultr Agent Arena (Track 1, Agent Sandboxing).

## What the PM sees

- **Usage map:** packed circles, where categories contain workflows and area is the number of conversations. People appear next to conversations, because a big cluster driven by a handful of people is itself an insight.
- **Two live questions:** "What are people doing?" and "What's not working?". On each click:
  1. GLM 5.3 writes a pandas program without seeing any data.
  2. The program runs in a fresh gVisor container on the sandbox VM, with no network, a read-only root filesystem and 512 MiB of memory.
  3. The gate validates every value.
  4. GLM explains the result using placeholders, and the UI fills in the verified numbers.
- **Search:** "Find a workflow…" highlights the matching published clusters, using one Jev call per query.
- **Detail panel:** needs and problems backed by evidence IDs, four friction signals (correction, repeated request, assistant limit, complaint), and top languages.
- **Fictional user story:** generated only from the published cluster, labelled as fiction, and validated before display.
- **Run details:** the generated code, the execution receipt (runtime, limits, timing, container removed) and the gate's verdict, plus a **containment check**. A runaway program is killed at its 2 s deadline, and a program that tries to export per-person rows is rejected by the gate.
- **Evaluation:** agreement with an independent reference set, zero detected canary leaks, metric reconciliation, gate attack tests and containment.

## Architecture

```
Browser ──HTTPS──▶ Caddy ─▶ FastAPI (app VM: keys, SQLite, pipeline, egress gate)
                                   │  Vultr VPC only (10.20.0.0/24), bearer token
                                   ▼
                     Runner (sandbox VM: no keys, egress locked to the VPC)
                                   │
                                   ▼
                     docker --runtime=runsc (gVisor), --network=none, read-only,
                     cap-drop ALL, 1 vCPU, 512 MiB, 64 pids, 10 s deadline
```

| Model role | Engine |
|---|---|
| Facets, naming, hierarchy, descriptions, privacy audit, analysis code, explanations, stories | GLM 5.3 / GLM 5.3 Flash on **Vultr Serverless Inference** |
| Friction decisions, theme classification, identifiability, "surprising" scoring, search relevance | **TypeSafe Jev** (calibrated, typed decisions) |
| Facet embeddings, used only to propose clusters | Fireworks `qwen3-embedding-8b` (only generalized facet sentences are embedded) |
| Every count, share and ordering | Python code in the sandbox, checked against a reference |

### Pipeline (`logless rebuild`)

1. Facets (GLM) and tri-state friction (Jev).
2. Embeddings, then k-means on a de-duplicated subset capped per person, then goal-named clusters that are consolidated into themes.
3. Jev classifies every conversation. Anything below 0.65 confidence goes to "Other or unclear".
4. Leftover loop: re-discover on Other when it exceeds 8%, at most 3 rounds.
5. Aggregation runs in the sandbox and is gated against the reference.
6. Hierarchy into categories, then re-filed by Jev.
7. Evidence-backed descriptions.
8. Privacy gate on every published string.
9. Atomic publish with provenance.

## Privacy model (and its limits)

- **The browser gets published aggregates only.** Serializers build each payload field by field from an allowlist. There is no route to a transcript, facet or conversation ID.
- **The sandbox receives no text.** It gets only typed assignments with per-job pseudonymous integers.
- **Rare findings are generalized, not suppressed.** There is no minimum cluster size. Wording is generalized until it passes the checks, and counts stay honest. A problem is labelled "common" only when at least 5 distinct people show it.
- **Published text passes several checks:** canary and injection tokens, contact, URL and ID patterns, overlap with distinctive source phrases, a GLM audit, and Jev's identifiability score.
- **This is not differential privacy,** and it makes no Clio-equivalent claim. Model providers process raw text. The dataset authors de-identified WildChat with Presidio. "People" means distinct hashed IPs, which is approximate.

## Run it locally

```bash
cp .env.example .env            # fill in the keys and random secrets
cd backend && uv venv -p 3.12 .venv && uv pip install -e ".[dev]"
.venv/bin/logless seed           # download the pinned WildChat shard, sample 5,000, plant fixtures
.venv/bin/logless rebuild        # run the pipeline and publish a snapshot
.venv/bin/logless eval           # write the evaluation report
.venv/bin/logless serve          # API on 127.0.0.1:8000
cd ../web && pnpm install && VITE_MOCK=0 pnpm dev   # UI on :5173
```

Live analyses need the runner (`runner/README.md`). Use Docker with `runsc`, or `runc` locally; the runtime used is reported honestly.

## Deploy

`infra/README.md` covers provisioning (two `vc2-4c-8gb` VMs in `sjc`, VPC, firewalls, gVisor, egress lockdown). `infra/deploy-app.sh [--data]` ships the API and web app.

## Repository

| Path | What |
|---|---|
| `backend/logless/` | Pipeline, providers, sandbox client, egress gate, API, eval |
| `backend/sandbox_tasks/` | Version-controlled programs that run in the sandbox (aggregation, containment fixtures) |
| `runner/` | Sandbox-VM job runner (FastAPI + docker CLI supervisor) |
| `web/` | Vite + React + TypeScript + shadcn/ui + d3-hierarchy |
| `infra/` | Provisioning, VM setup, Caddy, systemd, lockdown, deploy |
| `docs/CONTRACTS.md` | Shared contracts: snapshot, API, sandbox input/output, runner |

## Credits

WildChat-1M by Zhao, Ren, Hessel, Cardie, Choi and Deng (ICLR 2024), ODC-BY 1.0. External reference labels: Microsoft WildFeedback (ODC-By) and WildChat-AQA (ksx-wz). See `backend/logless/eval/external/README.md`. This project is inspired by Anthropic's Clio paper and is not affiliated with Anthropic, OpenAI or the dataset authors.
