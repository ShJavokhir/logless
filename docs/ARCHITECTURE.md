![logless architecture: model providers, app VM, sandbox VM, and offline and live flows](architecture.svg)

This describes the design in [CONTRACTS §0](CONTRACTS.md#0-design-change-sat-2030-the-sandbox-is-the-source-of-truth-for-live-answers), which overrides older sections. It is not a deployment attestation.

## Components

Caddy terminates HTTPS and serves the browser app. FastAPI orchestrates questions, search, stories and run status. SQLite `private.db` holds conversations, facets, friction decisions and assignments; `public.db` holds snapshots and public run artifacts.

On the **app VM**, `logless rebuild` transforms conversations → facets/friction → embeddings/discovery → classification → descriptions → privacy gate → published snapshot. Discovery includes leftover rounds and hierarchy construction. Trusted pipeline code computes map counts, distinct people, friction and languages after privacy processing, then publishes atomically. Aggregation does not run in the sandbox. Usage/Friction lenses read the snapshot.

## Trust boundaries & what crosses them

- **Browser ↔ app:** questions, search queries and snapshot IDs enter over HTTPS. Allowlist serializers release aggregate results, checked prose, generated code and sanitized receipts/status. Conversation text, facets and private conversation/user IDs are not browser payloads.
- **App ↔ providers, over HTTPS:** Vultr Serverless Inference runs GLM 5.3 (with Flash for facets): all LLM reasoning, including facets, naming/hierarchy, descriptions, privacy audits, question→plan, program writing/repair, explanations and stories. It processes raw conversation text for facets, generalized facets for downstream work, and questions or public data for live features. TypeSafe Jev processes raw text/facets for typed friction/classification decisions and published text for privacy/relevance decisions; search supplies the query and public titles/descriptions. Fireworks embeds **generalized facet sentences only**.
- **App ↔ sandbox:** HTTP over Vultr VPC `10.20.0.0/24`, authenticated with a shared bearer token. Jobs carry code, a bounded plan/contract, title-free cluster structure and typed assignment rows: randomized integer row/user pseudonyms, public node IDs and tri-state friction. No conversation/facet text crosses. Untrusted JSON results, receipts and bounded diagnostics return to the app; stderr never reaches the browser or repair prompt.

## Live question lifecycle

1. GLM interprets the question into a bounded, validated plan; unsupported requests stop here. `question` is the sole live intent.
2. GLM independently writes A (pandas) and B (stdlib) in parallel, using the plan, schema and data dictionary without data rows.
3. The runner executes each program in its own fresh gVisor container.
4. The app's egress gate checks strict JSON/structural limits, exact schema/plan, scoped IDs excluding Other, nonnegative integers, count≤base, shares within `1e-4`, ordering and result length. It checks published map consistency where derivable and requires identical canonical A/B outputs, with shares rounded to four decimals.
5. One repair round regenerates failing/disagreeing programs using fixed check names, never output values or stderr. Continued failure yields no answer. Success serves the **canonical sandbox result**, without a backend-computed live reference answer. GLM explains with validated placeholders; the browser fills verified numbers.

## Containment

Each container uses `runsc`, `--network=none`, a read-only root and inputs, 1 vCPU, 512 MiB, 64 pids and a 10-second execution deadline. Writable `/tmp` and `/out` are capped; only bounded result JSON is collected. Non-root execution, dropped capabilities and no-new-privileges supplement isolation. The supervisor kills overdue jobs, verifies removal and quarantines on cleanup failure. Containment fixtures exercise runaway termination and attempted per-person export.

## What runs where

| Component | Machine | Holds secrets? |
|---|---|---|
| Browser | Visitor | No model/runner keys; optional presenter token |
| Caddy, API, pipeline, gate, SQLite | App VM | Model keys, pseudonym salt, runner/presenter tokens; private data |
| Runner | Sandbox VM | Runner auth token; no API keys/cloud credentials |
| Programs A/B | Separate gVisor containers | No credentials or network; typed private rows (no text) |
| Model inference | External providers | Processes submitted inputs |
| Provisioning | Operator machine | Vultr cloud API key |

## Honest limitations

No differential privacy, minimum cluster size, or guarantee against inference/leaks. Model providers see inputs outside the VPC; generalized facets can retain sensitive information. Agreement can share model mistakes; snapshot checks cover only derivable metrics. “People” approximates distinct hashed IPs. Sandbox host egress permits VPC traffic plus metadata/DHCP and control exceptions; container networking remains disabled. The runner's Docker access is host-root-equivalent. See [infrastructure](../infra/README.md) and [runner](../runner/README.md) for operational details.

The reviewed intake event stream requires presenter authentication and withholds all per-conversation summaries. It exposes routing diagnostics to the presenter; the public UI receives published aggregates. Snapshot inputs are frozen before an intake snapshot becomes current. Missing frozen inputs fail closed rather than rebuilding a historical answer from mutable assignments.

The JSONL adapter accepts text conversations with explicit public source metadata in an isolated workspace. Its successful synthetic end-to-end test checks the processing mechanics, not live cross-domain model accuracy. The same GLM family generates A and B; independent calls and different implementation instructions do not imply statistically independent errors. Pseudonyms are randomized per export, then shared by A/B and repairs.
