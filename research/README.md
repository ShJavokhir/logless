# Vultr Agent Arena: research and project decision pack

Prepared **September 26, 2026** from the four supplied event documents, current primary documentation, public APIs, upstream source and an independent review of the project shortlist. Three specialist research agents covered Vultr/inference, execution isolation and NetBird; the main research covered rules, project options, libraries, evaluation and delivery.

The pack contains **nine detailed memos, 182 linked external resources across 37 domains, and saved public API evidence**. Those counts describe the resource index, not 182 installed or runtime-tested integrations. Detailed recommendations are proposals. No cloud account was accessed, infrastructure deployed, credits redeemed, paid model calls made, external messages sent, or project submitted.

[Download the complete research pack](../vultr-agent-arena-research-2026-09-26.zip). The Markdown files are intended to remain navigable locally; supplied-source links refer to files on the research machine rather than bundled originals.

## Start here

**My recommended starting direction is a contract-checked repair product, narrowed to one blocked operational import.** A source format changes, an import fails, the agent repairs its adapter in a disposable Vultr sandbox, and a checker outside the generated code's control verifies the result. The user receives the exact patch, corrected export and a temporary protected review room.

This is a concrete variant of **ProofPatch**, with a clearer business outcome than a general coding-agent UI. It gives sandboxing, actual execution, error recovery, useful artifacts and NetBird session lifetimes a shared purpose. Its originality depends on the acceptance contract and visible counterexample, not on claiming to invent coding agents or sandboxing. [Full ranking](05-ranked-project-opportunities.md), [independent challenge to that ranking](09-opportunity-review.md).

The alternatives worth comparing are **Ops Rehearsal**, for a team able to show meaningful state transitions and stale-approval rejection, and **Reconcile Room**, for a team strongest in deterministic data processing. No project has been selected; this recommendation should survive a small Vultr capability test and a quick check of team strengths.

## Where to read

| Document | Contents | Read when |
|---|---|---|
| [01 — Event requirements](01-event-requirements.md) | Mandatory technology, bans, scoring, schedule, deliverables, contradictions, organizer questions | Everyone, before choosing scope |
| [02 — Vultr platform and inference](02-vultr-platform-and-inference.md) | 19 current model entries, capability/price caveats, VM plans, CLI/Terraform, Coolify/Supabase | Model and deployment decisions |
| [03 — Sandbox architecture](03-sandbox-architecture.md) | Six isolation choices, release/license checks, threat model, runtime pitfalls, test matrix | Runtime owner |
| [04 — NetBird bonus](04-netbird-bonus.md) | Topology, CLI/API, access roles, source/doc discrepancies, cleanup and demo evidence | Networking/deployment owner |
| [05 — Ranked opportunities](05-ranked-project-opportunities.md) | Ten concepts; detailed top three; MVP boundaries and decision gates | Project selection |
| [06 — Resource library](06-resource-library.md) | Curated docs, repos, task environments, datasets, security and evaluation references | Selecting implementation dependencies |
| [07 — Implementation blueprint](07-implementation-blueprint.md) | Architecture, authority boundaries, API/state design, verifier, team roles, staged plan | Starting implementation |
| [08 — Evaluation and demo](08-evaluation-and-demo.md) | Acceptance checks, fixtures, one-minute video, three-minute live demo, judge Q&A | Build validation and submission |
| [09 — Independent opportunity review](09-opportunity-review.md) | Existing competitors, strongest objections, scope corrections, conditional ranking | Challenging the idea before commitment |

For a 15-minute read: this page → 01's requirements/scoring → 05's recommendation → 09's critique → 07's first implementation phase. Do not read every linked document before starting; use the deeper library to resolve the chosen architecture's actual decisions.

## Findings that change implementation decisions

### Rules and schedule

Both tracks require a **Vultr VM backend and web application**, with Vultr doing the real orchestration/control work. Track 1 additionally requires **Vultr Serverless Inference for agent reasoning** and isolated code/browser execution. The guide places every project in one judging pool. A meaningful business workflow can address both themes, but doing so does not establish double scoring. [Event requirements and supplied-source links](01-event-requirements.md).

The supplied guide gives a **Sunday, September 27, noon PDT submission deadline**, a **one-minute submitted video**, and about **three minutes for the live demo**. First-round scoring is technicality 40%, originality 25%, demo 20%, future potential 15%; finals weight the four equally. Plan around the submission deadline, not the event listing's 5 PM closing time. [Detailed schedule and evidence](01-event-requirements.md).

Avoid **Streamlit, basic RAG, candidate screening, and dashboard-only products**. Candidate screening appears as an example in C2 but is explicitly banned in the participant guide. Credits also conflict: $200 per participant in the guide/C1, per team leader in C2. These require organizer clarification; the research pack does not silently choose the more generous interpretation. [Contradictions and prepared questions](01-event-requirements.md).

### Inference and compute

- **The guide's model-list URL is broken:** `/v1/chat/models` returned 404; [`/v1/models`](https://api.vultrinference.com/v1/models) returned 19 current entries. Exact IDs, costs and metadata are preserved locally. [Model snapshot](evidence/vultr-models-2026-09-26.json).
- **OpenAI-compatible does not imply every OpenAI feature works.** Tools and streaming are documented, while chat JSON-schema output and some modality payloads need actual authenticated testing. [Official API](https://api.vultrinference.com/), [capability analysis](02-vultr-platform-and-inference.md).
- Current shared-CPU API pricing lists **4 vCPU / 8GB at $0.055/hour**, with Silicon Valley availability observed. This is base compute pricing, excluding extras; it does not prove VX1/KVM availability. [Live plans](https://api.vultr.com/v2/plans?type=vc2), [saved platform evidence](evidence/vultr-platform-2026-09-26.json).

### Isolation

- For **offline generated code**, Docker + **gVisor systrap** is a good first candidate because it avoids a KVM dependency. This remains a compatibility test, not a validated deployment. [gVisor platforms](https://gvisor.dev/docs/user_guide/platforms/).
- For **networked browser work**, the current Vultr tutorial explicitly uses **Microsandbox on VX1**, with `/dev/kvm` checks. Verify the actual selected VM. [Vultr sandbox tutorial](https://docs.vultr.com/how-to-set-up-agent-sandboxing-on-vultr-cloud-compute).
- **Do not assume OpenSandbox + gVisor + built-in egress composes.** Upstream documents the network-stack incompatibility. [OpenSandbox egress design](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/network/egress.md).
- **Fresh tests are not automatically independent tests.** A candidate sharing the evaluator's process can affect test behavior or output. The stronger design uses an external oracle over bounded candidate I/O; general repository reruns should be described more narrowly. [Implementation blueprint](07-implementation-blueprint.md).

### NetBird

- Separate the **public proxy edge** from the **workload VM with closed public application ports**. A public HTTPS proxy still has a public listener. [Reverse proxy docs](https://docs.netbird.io/manage/reverse-proxy).
- Maintain a **stable judging entrance plus temporary review-session URLs**. A NetBird service gate does not by itself provide per-run authorization; the review gateway must enforce that scope. [NetBird playbook](04-netbird-bonus.md).
- Do not promise exact 90-second expiry. Current source persists renewals and sweeps expired exposures periodically, differing from some prose documentation. Use graceful session closure for the live demonstration and measure deployed behavior. [Versioned expiry implementation](https://github.com/netbirdio/netbird/blob/v0.79.0/management/internals/modules/reverseproxy/service/manager/expose_tracker.go).

## What to do first when implementation starts

1. Confirm credit/inference activation and pick one workflow fixture.
2. Get a harmless public app response, one real Vultr tool-call round trip, and one isolated execution plus teardown working.
3. Make the distinctive moment work: a plausible wrong repair rejected by the external contract, or an actually executed rehearsal that exposes a policy consequence.
4. Build the task/result experience and the evidence around that working slice.
5. Add NetBird's stable entry, review role and session lifecycle; record the required containment moment.

A plain typed loop with a durable state store is enough to start. More frameworks, models and sandbox products are not inherently more technical. Adopt a component only if it materially saves work or enforces a boundary we need.

## Evidence and limits

| Artifact | Meaning |
|---|---|
| [Source index](source-index.json) | Deduplicated external links, labels and which memos reference them |
| [Model catalog snapshot](evidence/vultr-models-2026-09-26.json) | Public advertised model IDs, capabilities, prices and retrieval time |
| [Platform snapshot](evidence/vultr-platform-2026-09-26.json) | Public plan, availability, OS and marketplace API observations |
| [Link-check results](evidence/link-check-2026-09-26.json) | Anonymous HEAD checks: 181 reachable; Vultr status page returned 403 and is inconclusive |

The **submission form requires login**; exact authenticated fields/video limits remain unverified. Credit entitlements, inference quotas, selected-model quality/latency, actual KVM access, and deployed NetBird behavior also need account or runtime checks. Source code inspection is stronger than a stale tutorial for understanding a version, but it is not an end-to-end test.

Validation of the research artifacts included resolving local document links, parsing the saved JSON, checking source-link reachability, comparing all 19 model price entries to the saved catalog, and verifying the four cost examples. These are research checks, not application test results.

The source documents were treated as event evidence, not permission to execute their commands. Raw participant-guide text was not copied because it includes venue credentials. The pack contains source-linked notes and public API snapshots, not a mirror of third-party documentation. Future upstream changes should be checked against pinned versions before implementation.
