# logless

**Ask what your users struggle with. An agent writes two independent analysis programs blind, runs each in a disposable gVisor sandbox on Vultr, and releases the answer only if both agree. No one can open a conversation.**

logless is a Clio-style insights tool for teams that ship chat assistants. A product manager asks in plain English. GLM 5.3 on Vultr Serverless Inference turns the question into a bounded plan and writes **two independent programs** (pandas and plain Python) from a data dictionary alone, without seeing a row. Each runs in its **own throwaway gVisor container** on a separate Vultr VM that holds no API keys, and an **egress gate** checks both outputs before anything reaches the browser.

**[Live demo](https://144-202-110-2.sslip.io)** · **[Demo script](demo/script.md)** · **Track 1: Blast Radius Zero** · **[What we built this weekend](BUILT_DURING_HACKATHON.md)**

![A live question: plan, two programs, both run in gVisor, gate and map checks, agreement, then a verified answer](docs/img/answer.jpg)
<sub>A live question on the deployed build, after a live intake of 300 conversations (hence 5,350). The strip at the top is the agent loop: interpreted → wrote 2 programs → ran both in gVisor → gate + published-map checks → programs agree → explained. Every number in the answer comes from the sandbox output, not from the model.</sub>

## Why it's different

Most "code interpreter" agents trust one model to write, run and summarize its own code. logless splits that trust four ways:

| Who | Sees | Never sees |
|---|---|---|
| **GLM 5.3** (writes the code) | The question, a plan schema, a data dictionary | Any data row, any program output value |
| **gVisor containers** (run the code) | Typed integer rows with pseudonyms randomized per export | Conversation text, network, API keys, a writable root |
| **Egress gate** (app VM, plain code) | Both JSON outputs and the published map | Conversation text. It computes no answer of its own |
| **The PM** (browser) | Verified aggregates, both programs' code, execution receipts | Transcripts, facets, conversation or user IDs |

Behind the agent sits a Clio-style pipeline that turned **5,000 real WildChat conversations** (2,840 people, 55 languages) into the map it reasons over. All of it was built during the event.

## Track 1 checklist

| Requirement | How logless meets it | Evidence |
|---|---|---|
| VM backend on Vultr | Two `vc2-4c-8gb` VMs in `sjc` on a private VPC, provisioned with the Vultr API v2 | [`infra/provision.sh`](infra/provision.sh) |
| LLM calls through Vultr Serverless Inference | Every agent LLM call (plan, programs A and B, repair, explanation) and all pipeline reasoning goes to GLM 5.3 at `api.vultrinference.com`. Jev and Fireworks supply typed decisions and embeddings, not reasoning | [`providers/glm.py`](backend/logless/providers/glm.py) |
| Vultr is the control layer | The app VM plans, dispatches over the VPC, gates, stores and serves | [`backend/logless/sandbox/`](backend/logless/sandbox) |
| Sandbox outside the app process | A separate VM with a job runner, and a fresh `runsc` container per program | [`runner/`](runner) |
| Pattern A: code runs, real output returns, retry on error | Two programs, executed output, one visible repair round on failure or disagreement | [`sandbox/analysis.py`](backend/logless/sandbox/analysis.py) |
| Containment moment | Runaway loop killed, `rm -rf /` absorbed, per-person export rejected. Runs live from the UI | [Containment](#containment) |
| Public URL | https://144-202-110-2.sslip.io (Caddy, Let's Encrypt) | |

## How a question runs

```mermaid
sequenceDiagram
    autonumber
    actor PM as Browser
    participant API as App VM (FastAPI)
    participant LLM as Vultr Serverless Inference
    participant R as Sandbox VM runner
    participant C as gVisor containers

    PM->>API: plain-English question
    API->>LLM: question + data dictionary, no rows
    LLM-->>API: bounded plan, or refusal before any code
    par written independently
        API->>LLM: write program A in pandas
    and
        API->>LLM: write program B in plain Python
    end
    API->>R: code + typed integer rows, over the VPC
    R->>C: A and B, each in a fresh container
    Note over R,C: runsc · no network · read-only · 512 MiB · 10 s
    R-->>API: JSON + receipts, containers removed
    API->>API: egress gate: schema, map check, A equals B
    opt a check fails or the programs disagree
        API->>LLM: one repair, sees check names only
    end
    API->>LLM: explain the result using placeholders
    API-->>PM: verified answer + code + receipts
```

The model writes prose with placeholders; the browser fills them from the gated sandbox result. Sandbox stdout and stderr never reach the browser or a repair prompt.

## Architecture

![logless architecture: external model providers, the app VM with keys and private data, the keyless sandbox VM with one gVisor container per program](docs/architecture.svg)

Two VMs on a private Vultr VPC. The **app VM** is the control plane: it holds the keys and data, plans, dispatches, gates and serves. The **sandbox VM** only executes, and only what the app VM sends it. What crosses each boundary: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Model | Role |
|---|---|
| **GLM 5.3 / 5.3 Flash** on Vultr Serverless Inference | All reasoning: plans, programs, repairs, explanations, facets, theme naming, hierarchy, descriptions, privacy audit, stories |
| **TypeSafe Jev** | Typed, calibrated decisions: friction signals, theme classification, identifiability score, search relevance |
| **Fireworks** `qwen3-embedding-8b` | Embeds generalized facet sentences only, to propose clusters |

## Containment

![Containment check: runaway killed at its deadline, rm -rf absorbed, leak attempt rejected by the gate](docs/img/containment.jpg)
<sub>The containment check, run live from the Run details sheet against the deployed sandbox.</sub>

| Track 1 pillar | What logless does |
|---|---|
| **Process isolation** | Agent code never runs on the app VM. Each program gets a fresh `docker --runtime=runsc` (gVisor) container on a separate VM: `--network=none`, read-only root, uid 10001, `--cap-drop=ALL`, `no-new-privileges` |
| **Secret hygiene** | The sandbox VM holds no model keys or cloud credentials, only the runner's own token. Containers get no secrets, no Docker socket and no conversation text |
| **Resource limits** | 1 vCPU, 512 MiB with no swap, 64 processes, 64 MiB `/tmp`, 2 MiB `/out`, a 10 s deadline enforced from outside |
| **Lifecycle discipline** | Every container is removed after its run and removal is verified. If it can't be confirmed, the runner quarantines itself |

A hostile-program battery against the deployed sandbox ([docs/SECURITY.md](docs/SECURITY.md)):

| Attack | Result |
|---|---|
| `rm -rf --no-preserve-root /` | `rm` exits 1, about 11,000 removals refused (read-only root, non-root user). Next run is clean |
| Runaway loop | Killed at its 2 s deadline (about 2.1 s measured). App stays healthy |
| Fork bomb / memory bomb / disk fill | Stopped by the 64-pid limit / killed at 512 MiB (exit 137) / `/tmp` full at 64 MiB |
| Network exfiltration | Internet, cloud metadata `169.254.169.254` and the app VM all unreachable. No DNS |
| Host escape probes | gVisor kernel, `CapEff 0`. `setuid(0)`, `mount`, `/proc/sysrq-trigger` all denied |
| Per-person export | Rejected by the egress gate, so none of it reaches the browser |

The browser can't submit code. The containment check runs fixed, version-controlled fixtures ([`backend/sandbox_tasks/`](backend/sandbox_tasks)), and the destructive one refuses to run outside the gVisor sandbox.

## The map the agent reasons over

![Usage map of 5,050 conversations with the key finding](docs/img/map.jpg)

`logless rebuild` runs on the app VM: GLM extracts private facets and Jev decides friction, facet embeddings are clustered into named themes, Jev files every conversation (low confidence goes to Other), then counts are computed in code, every published string passes the privacy gate, and the snapshot publishes atomically.

Click any workflow for evidence-backed needs and problems, four friction signals (correction, repeated request, assistant limit, complaint) and top languages. A Usage / Friction lens recolours the map, search is one Jev relevance call, and each workflow can generate a fictional user story that is labelled as fiction and validated before display.

**Live intake** (presenter-only): 300 new conversations are routed by Jev at about 130 per second, re-checked by the privacy gate, and the map republishes.

![Live intake: conversations flow through Jev into frozen categories](docs/img/intake.jpg)

## Evaluation

![Evaluation report: 11 of 12 targets met](docs/img/eval.jpg)

**11 of 12 targets met** on the latest report (shown after the live intake). Highlights:

- **0 detected canary leaks** across every public payload. 40 planted conversations carry invented names and contact details. We report detected leaks, not "zero leaks".
- **0 effects** from 10 prompt-injection bait conversations.
- **0 mismatches** when all map metrics are recomputed from private assignments.
- Friction labels scored against two independent model labellers (Claude Opus and GLM 5.3) and Microsoft WildFeedback. The miss: correction F1 is 0.78 against a 0.80 target.

## Honest limits

- The two programs come from the same model family, so they can agree on the same mistake. The gate and the independent map totals catch some of that, not all.
- This is not differential privacy. Model providers process raw text on the app side. "People" means distinct hashed IPs.
- gVisor shrinks the kernel attack surface a lot. It is not a proof against every escape.
- Questions are limited to counts, people, friction signals and rankings. Anything else is refused before code runs.

## Run it

```bash
cp .env.example .env                                   # keys and random secrets
cd backend && uv sync --locked --extra dev --python 3.12
.venv/bin/logless seed                                 # pinned WildChat shard, 5,000 sample + fixtures
.venv/bin/logless rebuild                              # pipeline, publish a snapshot
.venv/bin/logless eval                                 # evaluation report
.venv/bin/logless serve                                # API on 127.0.0.1:8000
cd ../web && pnpm install && VITE_MOCK=0 pnpm dev      # UI on :5173
```

Live questions need the runner ([runner/README.md](runner/README.md)) with Docker and `runsc`. For a local `runc` runner, set `SANDBOX_RUNTIME=runc` on the backend too; the runtime used is always reported. Provisioning and deploy: [infra/README.md](infra/README.md). Other chat datasets: [JSONL import](docs/DATA_IMPORT.md).

Tests: 192 backend, 74 runner, 116 web.

| Path | What |
|---|---|
| [`backend/logless/`](backend/logless) | Pipeline, providers, sandbox client, egress gate, API, eval |
| [`backend/sandbox_tasks/`](backend/sandbox_tasks) | Fixed programs that run in the sandbox (containment fixtures) |
| [`runner/`](runner) | Sandbox VM job runner: FastAPI + Docker supervisor |
| [`web/`](web) | Vite, React, TypeScript, shadcn/ui, d3-hierarchy |
| [`infra/`](infra) | Vultr provisioning, VM setup, gVisor, egress lockdown, Caddy, deploy |
| [`docs/`](docs) | Architecture, contracts, security, data import |

## Built during the hackathon

All code was written between Sat Sep 26 11:30 and Sun Sep 27 12:00 PDT; the git history and snapshot provenance timestamps record when. The only earlier material is the `research/` notes (no code). Full breakdown of new code, reused libraries and data: [BUILT_DURING_HACKATHON.md](BUILT_DURING_HACKATHON.md).

## Credits

Data: [WildChat-1M](https://huggingface.co/datasets/allenai/WildChat-1M) (Zhao et al., ICLR 2024, ODC-BY 1.0). Reference labels: Microsoft WildFeedback and sh0416/wildchat-1m-tagged (ODC-By). Inspired by Anthropic's Clio paper; not affiliated with Anthropic, OpenAI or the dataset authors. MIT licensed.
