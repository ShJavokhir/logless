# logless — shared contracts

Every component (pipeline, API, runner, web) builds against this file. If you need to change a contract, change it here first and say so in your report.

## 0. Design change (Sat 20:30): the sandbox is the source of truth for live answers

An audit found that live answers were precomputed by the backend, and the sandbox only confirmed them. This section overrides anything below that conflicts with it.

- **One live intent: `question`.** `usage` and `friction` are removed from the API. "What are people doing?" and "What's not working?" become example questions the interpreter turns into plans. The map's Usage/Friction lens is a view of published data, and it needs no run.
- **No runtime reference.** The backend never computes a live answer. For each validated Plan, GLM writes **two independent programs** in parallel with different instructions: **A** uses pandas, and **B** uses only the Python standard library (`csv`, `json`, `collections`), with no pandas or numpy. Each runs in its own fresh gVisor container.
- **Gate checks on each output:**
  - strict parse and structural limits;
  - an exact schema, with the plan echoed exactly;
  - ids are allowlisted, within scope, and never Other;
  - integers are ≥ 0, `count` ≤ `base`, and `share` equals count ÷ base within 1e-4;
  - ordering follows `rank_by` (desc, then id asc);
  - length is min(limit, groups in scope).
- **Consistency with the published snapshot,** wherever the plan makes it derivable:
  - measure `conversations` with no signal: each row's `base` equals that node's published `conversations`, and `total_base` equals the scope's published total excluding Other;
  - measure `people` with no signal: each row's `base` equals the node's published `users`;
  - `signal: "any_friction"` with measure `conversations`: each row's `count` equals the node's published `friction.conversations`;
  - a named signal with measure `conversations`: each row's `count` equals the node's published `friction.signals[signal]`.

  The published snapshot comes from the pipeline, and the programs come from the agent, so these are genuine cross-checks.
- **Agreement:** after canonicalization (shares rounded to 4 dp), A's and B's outputs must be identical.
- **Repair:** on a gate failure, a crash or a disagreement, one repair round regenerates the failing or disagreeing program(s). The repair prompt gets only the check names from the fixed vocabulary, e.g. "Programs disagree on row 3 · count". It never gets values or stderr. After that, the run fails honestly.
- **What's served:** the sandbox output itself, canonicalized. `Run.attempts_log` entries gain `program: "A" | "B"`. `Run.verdict` lists the per-program checks, the snapshot-consistency checks and "Two independent programs agree".
- **Published map numbers** are computed by the pipeline's own trusted code on the app VM, and nothing in the product claims otherwise. `provenance.stats_source` is removed. Aggregation no longer runs in the sandbox, because it is trusted code and gains nothing from containment.
- **The sandbox runs only untrusted, agent-written code:** live question programs, plus the containment fixtures.

## 1. Dataset (hardcoded input)

- Source: `allenai/WildChat-1M` on Hugging Face, revision `7d6490e462285cf85d91eabea0f9a954fbddcd1f`, file `data/train-00000-of-00014.parquet` (Apr 8 – May 4 2023, 59,857 conversations, 13,908 hashed IPs). License ODC-BY 1.0; attribution: Zhao et al., "WildChat: 1M ChatGPT Interaction Logs in the Wild", ICLR 2024.
- Sample: seeded uniform random sample of conversations whose first user message is non-empty. Default `SAMPLE_SIZE=5000`, `SAMPLE_SEED=20260926`. All languages kept.
- Row key: the first turn's `turn_identifier` (`conversation_hash` is not unique).
- Rendering for models: `role: content` lines; each message capped at 3,000 chars (head + ` […] ` + tail 500); whole conversation capped at 16,000 chars (opening + `[… middle of conversation omitted …]` + ending 4,000). Truncation is recorded (`truncated` flag) so the audit can compare full vs truncated labels.
- Evaluation fixtures: `N_CANARY=40` planted synthetic conversations, each carrying a unique invented name + email + phone (canary tokens). They go through the pipeline like any other conversation (0.8% of the map) and are disclosed in the manifest (`fixtures.canary_conversations`). Their tokens must never appear in anything the browser can receive. We report "zero detected canary leaks", never "zero leaks".

## 2. Identifiers

| ID | Format | Scope |
|---|---|---|
| Conversation | `c_` + sha256("conv:" + turn_identifier)[:12] | private |
| User pseudonym | `u_` + HMAC-SHA256(`PSEUDONYM_SALT`, hashed_ip)[:10] | private |
| Build | `b_` + UTC `YYYYMMDDTHHMMSS` | private |
| Snapshot | `snap_` + UTC `YYYYMMDDTHHMMSS` + `_` + 4 hex | public |
| Category | `cat_` + 6 hex (stable within a snapshot) | public |
| Leaf cluster | `cl_` + 6 hex; the catch-all leaf is `cl_other` | public |
| Evidence item | `n1..nK` (needs) / `p1..pK` (problems), unique within a cluster | public |
| Run | `run_` + 12 hex | public |

Sandbox jobs never see `c_`/`u_` IDs: each job gets fresh per-job integers (`row`, `user`) from a random permutation.

## 3. Friction signals (Jev, tri-state)

Signals: `correction`, `repeat_request`, `assistant_limit`, `complaint`. Each decision is one of `observed | not_observed | unclear`; a decision whose top probability is < 0.65 is stored as `unclear`. Question wording lives in `backend/logless/pipeline/questions.py` (versioned `FRICTION_QV`).

- Observed friction (per conversation) = at least one signal `observed`.
- Unclear (per conversation) = no signal `observed` and at least one `unclear`.
- Signals overlap and are never summed.

## 4. Storage (app VM: `/var/lib/logless`, local dev: `./var`)

- `private.db` (SQLite): `conversations`, `facets`, `friction`, `themes`, `assignments`, `builds`, `llm_cache`, plus pipeline-owned `facet_checks` (PII check per facet) and `embedding_cache` — backend only. Embeddings in `embeddings/<build_id>.npy` + ids json. Per-build private artifacts (structure, evidence ids, gate detail) in `artifacts/<build_id>/`. `builds.snapshot_id` maps a build to the snapshot it published.
- `public.db` (SQLite): `snapshots(snapshot_id, created_at, json, is_current)`, `runs`, `stories`, `eval_reports`.
- Browser payloads are built field by field from `public.db` by allowlist serializers. Nothing browser-facing carries a `c_`/`u_` ID, source text, facet text, or canary.

## 5. Public snapshot (`GET /api/snapshot`)

```ts
type Signal = "correction" | "repeat_request" | "assistant_limit" | "complaint";
type Metrics = {
  conversations: number;          // union over descendants
  users: number;                  // "people": distinct hashed-IP pseudonyms (approximate — shared/changing IPs), recomputed per node, never summed
  share: number;                  // conversations / snapshot conversations (0..1)
  friction: {
    conversations: number;        // >=1 observed signal
    share: number | null;         // friction.conversations / conversations; null if 0 conversations
    unclear: number;
    signals: Record<Signal, number>;
  };
  languages: { name: string; conversations: number }[]; // top 5; a language is listed only with >= 5 conversations from >= 3 people, the rest fold into a final {name: "Other languages"} entry (present only when non-zero), so entries sum to `conversations`
};
type Node = Metrics & {
  id: string; level: 1 | 2; parent_id: string | null;
  title: string;                  // <= 8 words
  short_title: string;            // map label: 1–3 words, <= 22 characters, goal-flavoured, unique across all nodes (case-insensitive); cl_other = "Other or unclear", its category = "Other"
  description: string;            // 1–2 sentences, generalized
  children?: string[];            // categories only: leaf ids
  needs?: { id: string; text: string }[];                       // leaves only
  problems?: { id: string; text: string; signal: Signal | null; support: "observed" | "common" }[]; // leaves only
  surprising?: { flag: boolean; score: number };                // leaves only
  is_other?: boolean;
};
type Snapshot = {
  snapshot_id: string; created_at: string;
  workspace: { name: string; description: string };
  dataset: {
    name: "WildChat-1M"; source_url: string; revision: string; license: "ODC-BY-1.0"; attribution: string;
    period_start: string; period_end: string;   // YYYY-MM-DD
    conversations: number; users: number; languages: number;
    sample_note: string;
    fixtures: { canary_conversations: number; injection_conversations: number };  // 40 canary + 10 injection-bait fixtures, all counted in totals
  };
  totals: Metrics;
  categories: Node[];             // level 1, 4–8 of them
  clusters: Node[];               // level 2 leaves, 15–35 incl. cl_other
  intended_uses: string[];        // what the assistant was designed for; drives "Surprising"
  provenance: {
    pipeline_version: string; dataset_hash: string;
    models: Record<string, string>;         // role -> model id; roles: facets, friction, embeddings, naming, consolidation, classification, hierarchy, descriptions, privacy_audit, identifiability, surprising (pipeline) + analysis_code, explanation, story, relevance (API live features)
    prompt_versions: Record<string, string>;
    discovery_rounds: number; build_seconds: number;
    stages: { stage: string; started_at: string; finished_at: string; counts: Record<string, number>; models: string[] }[];
  };
};
```

Invariants: leaf `conversations` sum to `totals.conversations`; a category's metrics are recomputed over its leaves' conversations (union); every leaf has exactly one parent. `support: "common"` requires the problem/need to be shown by conversations from >= 5 distinct people; otherwise `"observed"` ("an observed request"). Shares are recomputed by the backend and rounded to 4 decimals before publishing.

## 6. Web API (FastAPI on the app VM, behind Caddy at `/api/*`)

| Method + path | Body | Returns |
|---|---|---|
| GET `/api/snapshot` | — | `Snapshot` |
| POST `/api/search` | `{query: string (<=200 chars), snapshot_id}` | `{snapshot_id, query, results: {cluster_id, relevance: "relevant"\|"unclear"\|"not_relevant", p: number}[], elapsed_ms}` |
| POST `/api/analyses` | `{intent: "question", question: string (1–200), snapshot_id}` | `{run_id}` (a run already in flight for the same normalized question + snapshot returns its id). `usage`/`friction` → `422` (retired, §0) |
| GET `/api/runs/{run_id}` | — | `Run` |
| POST `/api/clusters/{id}/story` | `{snapshot_id}` | `{status: "ready", story: Story}` or `{status: "pending", run_id}` |
| POST `/api/demo/containment` | `{}` | `{run_id}` |
| GET `/api/eval` | — | `EvalReport` |
| GET `/api/health` | — | `{status: "ok"\|"degraded", sandbox: "reachable"\|"unreachable", snapshot_id}` |

```ts
type RunState = "queued" | "planning" | "executing" | "validating" | "repairing" | "explaining" | "completed" | "failed";
type Run = {
  run_id: string; kind: "analysis" | "story" | "containment" | "intake"; intent: "question" | null;  // §0: usage/friction retired
  snapshot_id: string; state: RunState; created_at: string; updated_at: string;
  stages: { name: string; status: "pending" | "running" | "done" | "failed" | "skipped"; started_at: string | null; finished_at: string | null; detail: string | null }[];
  attempts: number;                         // sandbox executions used (max 2 for analyses)
  code: string | null;                      // the GLM-written program (contains no data)
  receipt: Receipt | null;                  // last sandbox execution
  verdict: { passed: boolean; checks: { name: string; passed: boolean; detail: string }[] } | null;
  result: UsageResult | FrictionResult | null;  // only after the gate passed
  explanation: { text: string; metric_refs: string[] } | null; // text uses {{metric}} placeholders the UI fills from `result`
  containment: { deadline_ms: number; elapsed_ms: number; killed: boolean; container_removed: boolean; app_health: "ok" | "degraded"; destructive: { command: "rm -rf --no-preserve-root /"; exit_code: number | null; refused: number | null; container_removed: boolean; root_read_only: boolean | null; binaries_intact: boolean | null; next_run_clean: boolean; contained: boolean } | null; followup_passed: boolean; leak_attempt_rejected: boolean; leak_rejection_checks: string[] } | null;
  error: { code: string; message: string } | null;  // never raw stderr
  // §8b adds: question: string | null; plan: Plan | null; attempts_log: {attempt,program:"A"|"B",code,code_sha256,receipt,verdict,repair_reason}[]
  intake: { batch_size: number; decided: number; other: number; published_snapshot_id: string; base_snapshot_id: string; deltas: { id: string; conversations_before: number; conversations_after: number; friction_share_before: number | null; friction_share_after: number | null }[] } | null;  // §11, set on a completed intake run
};
type Receipt = {
  job_id: string; runtime: "runsc" | "runc"; image: string; code_sha256: string;
  exit_code: number | null; elapsed_ms: number; timed_out: boolean; output_bytes: number; container_removed: boolean;
  limits: { cpus: number; memory_mb: number; pids: number; timeout_s: number; network: "none"; read_only_root: true };
  started_at: string; finished_at: string; host: string;
};
type Story = { cluster_id: string; snapshot_id: string; label: string; first_name: string; text: string; citations: string[]; model: string; generated_at: string };
type EvalReport = { snapshot_id: string; generated_at: string; checks: { id: string; name: string; value: string; target: string; passed: boolean | null; detail: string }[] };
```

The browser polls `GET /api/runs/{id}` once a second. Public endpoints are rate- and size-limited. There are no accounts.

API details (implemented in `backend/logless/api/`):

- **Errors** are always `{code, message}` (no stack traces): `422 invalid_request` (names the field, never echoes input), `409 stale_snapshot` (body `snapshot_id` is not the current one), `404 not_found`, `413 payload_too_large` (bodies > 8 KiB), `429 rate_limited` (per-IP token buckets) or `429 busy` (≥ 4 runs in flight), `429 budget_exhausted` (global hourly caps across all visitors — searches 600/h, analyses 120/h, stories 60/h, containment checks 60/h, env-configurable; the message is written for people and a `Retry-After` header is set; cached searches/stories and requests that join an in-flight run never consume budget), `503 no_snapshot | snapshot_blocked | model_unavailable | search_timeout`. `POST /api/analyses` and `/api/demo/containment` return `200 {run_id}`.
- **Search** runs on a dedicated pool (4 concurrent Jev calls, 8 s timeout, 2 attempts) so it never occupies the threads that serve health and run polling; identical in-flight queries share one Jev call; at most 16 distinct queries in flight (`429 busy`). Results cover every published leaf, sorted relevant (p desc) → unclear → not_relevant; `p` is Jev's top probability; `elapsed_ms` is the Jev call (≈ 0 when served from the per-(snapshot, normalized query) cache). Jev sees only the query and each leaf's public title + description.
- **Stories**: `POST …/story` returns `{status: "pending", run_id}` while a story run is in flight; when that run is `completed`, POST again to get `{status: "ready", story}` (cached per snapshot + cluster). A run that fails validation twice ends `failed` with `error.code = "story_rejected"` and nothing is shown. Leaves only (categories → 404).
- **Eval** with no report for the current snapshot: `404 {code: "no_eval_report", message, snapshot_id, generated_at: null, checks: []}`.
- **Health**: `sandbox` is "reachable" if the runner's `/health` answers `status: "ok"` within 1.5 s (cached 3 s); `status` is "ok" only with a current snapshot and a reachable sandbox.
- **Run stages** (`name` values; the UI shows the latest started stage of each name):
  - analysis (question only, §0): `interpreting → planning → executing → validating → explaining`; `planning` writes programs A and B, `executing` runs them in parallel, `validating` covers both programs' checks, the snapshot-consistency checks and the agreement check. A repair inserts `repairing → executing → validating` (same names again) before `explaining`. `attempts` counts sandbox executions over both programs (2 normally, up to 4).
  - story: `writing → checking`; a repair appends `writing → checking` again.
  - containment: `runaway → cleanup → health → destructive → followup → leak_attempt`. The `containment` object is set when the run ends (the named stages drive the live checklist until then). Every flag is set only from observed evidence (`killed` from a timed-out job, `container_removed` from the runner's verified removal, `followup_passed` from a passing verdict of a fixed benign stdlib program (`sandbox_tasks/followup.py`, answering the fixed plan "conversations by category, top 5") including the snapshot-consistency checks, `leak_attempt_rejected` only from an actual gate rejection). The **destructive** stage runs a fixed `sandbox_tasks/destructive.py` fixture (`rm -rf --no-preserve-root /` via subprocess as the sandbox user) in a fresh container (normal limits, 8 s deadline). The fixture runs the command only when every sandbox condition holds (Linux, uid 10001, read-only root, gVisor kernel, `/out` mounted) and otherwise reports `ran: false`, which fails the stage. `destructive.contained` is judged **from outside** and set true only when the fixture ran, the container exited and was verified removed, the runner stayed healthy, and the follow-up program then ran cleanly from the same pinned image (`next_run_clean`). The fixture's own `/out` report is untrusted and informative only: `exit_code` (rm's own exit code — 1 in the deployed sandbox — or null on timeout; not the container's), `refused` (how many removals rm reported as refused, a count; the error text is discarded), `root_read_only` and `binaries_intact` come from that report (bool, or null if absent) and are shown as detail. The run is `completed` only if killed, container_removed, app_health ok, `destructive.contained` and followup_passed and leak_attempt_rejected all hold; otherwise it is `failed` with `error.code` `leak_fixture_failed` (the leak program produced no output, so the gate was not exercised), `containment_check_failed` (message lists what was not observed) or `no_inputs`; `receipt` is the runaway job's receipt; `verdict` is the leak attempt's gate verdict; `attempts` = 4 sandbox executions; `result`/`code`/`explanation` are null.
- **Receipts** show only validated runner measurements (state flags, exit code, timings, sizes). `image` and `host` come from app-side config (`SANDBOX_IMAGE`, `SANDBOX_IMAGE_DIGEST` — the digest is shown only if the runner reports exactly that reference — and `SANDBOX_HOST_LABEL`), `limits` from what the app submitted, `code_sha256` from the app's own hash of the program.
- **Node `short_title`** (≤ 24 chars) is always served: the published value, or the title shortened at a word boundary with "…". It goes through the same leak checks as the title.
- **Explanation placeholders** are dotted paths into the validated `result` (§8b): `{{rows.N.id}}` (the UI renders the published title), `{{rows.N.count}}`, `{{rows.N.base}}`, `{{rows.N.share}}` (renders as a percentage), `{{total_count}}`, `{{total_base}}`. `rows[N].x` is accepted and normalized to `rows.N.x`. The backend checks that every placeholder resolves, that the model text has no digits or quantity words outside placeholders, ≤ 2 sentences, ≤ 55 words, and that only row 0 is called the highest/most; otherwise one retry, then a fixed template. `metric_refs` lists the placeholders used. `POST /api/analyses` with `usage`/`friction` → `422`; stored runs of those retired intents → `410 {code: "run_retired"}`.

## 7. Sandbox input (typed assignments, no text)

Files placed read-only at `/in` for every analysis/aggregate job:

- `assignments.csv` — one row per conversation: `row` (int, per-job), `user` (int, per-job), `leaf_id`, `category_id`, `correction`, `repeat_request`, `assistant_limit`, `complaint` (each `observed|not_observed|unclear`). Nothing else: no language, turn counts, timestamps or text (minimum necessary for the intents).
- `clusters.json` — `[{"id", "parent_id", "level", "is_other"}]` (no titles).
- `contract.json` — the output contract for the job (`intent`, `snapshot_id`, `output_path`, `fields`, `ordering`, `rules`).
- `program.py` — the program (GLM-written or a version-controlled task from `backend/sandbox_tasks/`). It must write exactly one file, `/out/result.json`.
- `main.py` — the runner-owned bootstrap (the container command is `python /in/main.py`); see §9.

Per-job pseudonyms: `row` and `user` are fresh random permutations (1..n) for every export; the mapping back to `c_`/`u_` ids stays in backend memory and is never stored or sent. A missing or invalid friction decision (for the current `FRICTION_QV`) is exported as `unclear`; an assignment whose theme maps to no leaf goes to the `is_other` leaf.

Where live analyses get their inputs: the pipeline's `stats` stage calls `logless.sandbox.export.save_cluster_map(snapshot_id, build_id, clusters)` for every snapshot it publishes, which stores the private theme → leaf mapping in `private.db.sandbox_cluster_map` keyed by `snapshot_id`. `POST /api/analyses` and the containment follow-up/leak fixtures rebuild the typed inputs from it; a snapshot without an entry cannot run live questions (`error.code = "no_inputs"`).

## 8. Analysis result schemas (validated by the egress gate on the app VM)

> **Superseded by §0.** The `usage`, `friction` and `aggregate` schemas below, the "reference equality" gate rules and the reference-based check names are retired: there is no runtime reference, and aggregation no longer runs in the sandbox. The only live result is the `question` result (§8b), checked as described in §0 and in "Gate as implemented (§0)" under §8b. The strict-parse, structural-limit, allowlist and fixed-vocabulary rules below still apply.

```jsonc
// usage: every leaf exactly once, ordered by conversations desc, then cluster_id asc — except the catch-all
// leaf (cl_other / is_other), which is always the LAST row whatever its numbers
{"intent": "usage", "snapshot_id": "snap_…", "total_conversations": 5040,
 "rows": [{"cluster_id": "cl_…", "conversations": 812, "users": 97, "share": 0.1611}]}
// friction: every leaf exactly once, ordered by friction_conversations desc, then cluster_id asc — except
// the catch-all leaf (cl_other / is_other), which is always the LAST row
{"intent": "friction", "snapshot_id": "snap_…", "total_conversations": 5040,
 "rows": [{"cluster_id": "cl_…", "conversations": 812, "friction_conversations": 140, "friction_share": 0.1724,
           "correction": 60, "repeat_request": 70, "assistant_limit": 20, "complaint": 9, "unclear": 31}]}
// aggregate (pipeline stage 5): totals + every category and leaf, all Metrics fields except languages;
// nodes ordered categories by id asc, then leaves by id asc; friction.share is null when conversations is 0
{"intent": "aggregate", "snapshot_id": "snap_…", "total_conversations": 5040,
 "totals": {"conversations": 5040, "users": 3100, "share": 1.0,
            "friction": {"conversations": 900, "share": 0.1786, "unclear": 120,
                         "signals": {"correction": 300, "repeat_request": 280, "assistant_limit": 250, "complaint": 90}}},
 "nodes": [{"id": "cat_…", "conversations": …, "users": …, "share": …, "friction": {…}}, {"id": "cl_…", …}]}
```

In usage/friction rows, `friction_share` is `0.0` for a leaf with 0 conversations. `run_aggregate` returns `metrics = {node_id: Metrics-without-languages, "total": …}` taken from the reference (shares rounded to 4 decimals exactly like `pipeline.stats.metrics_of`), plus `totals`, `total_conversations`, `receipt`, `verdict`; it raises `SandboxUnavailable` (runner unreachable) or `AggregateRejected` (job failed or gate rejected; carries `.verdict`, `.receipt`).

Published map metrics (pipeline stage 5, per §0): computed by trusted pipeline code on the app VM, not in the sandbox. `backend/logless/pipeline/stats.py`: `assignment_rows(build_id, clusters)` (one private row per conversation: conv_id, user_id, language, leaf_id, category_id, four friction choices) and `reference_metrics(rows, clusters)` (node_id → Metrics-without-languages, plus `"total"`); languages per node via `languages_by_node`. `logless rebuild --no-cache` (or `LOGLESS_NO_CACHE=1`) makes every model and embedding call fresh (cache reads off, writes on) and recomputes facets and friction; each provenance stage record then carries `counts.fresh_model_calls = 1`.

Gate rules: one JSON document ≤ 1 MiB; bounded structure (see check list below); strict parse (duplicate keys, NaN/Infinity, booleans-as-integers rejected); exact schema (unknown keys rejected); strings only from the allowlist (intent names, current snapshot id, current leaf/category ids); integers ≥ 0; integers exactly equal to the trusted reference computed in the backend from the same assignments; `share` values within 1e-4 of the reference; ordering exactly as the rule; every leaf present once. On pass, the stored/served result is re-serialized canonically from the REFERENCE values (shares rounded to 4 decimals), never the sandbox bytes. Check names and details come from a fixed vocabulary and never echo output values. Any failure → the run shows the failed checks; nothing from the output reaches the browser.

Gate check names (fixed vocabulary, in evaluation order; checks after a parse/schema failure are not run): "Result file received", "Size within 1 MiB", "Strict JSON parse", "Only allowlisted field names", "Only allowlisted string values", "Schema matches exactly", "Intent matches the request", "Snapshot id is the current snapshot", "Cluster ids belong to this snapshot", "Counts are non-negative integers", "Every leaf exactly once" / "Every category and leaf exactly once", "Total matches the trusted reference", "Counts match the trusted reference", "Shares within 1e-4 of the reference", and the ordering check ("Ordered by conversations, then cluster id (Other last)" / "Ordered by friction conversations, then cluster id (Other last)" / "Ordered categories, then leaves, by id"). Right after the parse, "Document within structural limits" rejects anything deeper than 6 levels, with more than 40,000 values, a list longer than 1,000, an object with more than 32 fields or a string/field name longer than 64 characters — before any other check walks the document; each check keeps at most 20 diagnostics (the rest are counted). Details name positions structurally (`rows[3].users`) and quote a field name only if it belongs to our schema or input columns (e.g. "unknown field 'user' in rows[0]").

Repair prompts never contain sandbox-authored text: only the failed gate check names and a trusted error category derived from the exception type (e.g. `KeyError: missing column`, `result schema: missing field`), because the repaired program is public (`Run.code`).

## 8b. Open questions: the `question` intent (bounded plan, verified execution)

Why it exists: the `usage` and `friction` intents regenerate reports that already exist, so they prove *execution*. The `question` intent proves *usefulness*. A PM asks something the snapshot doesn't already answer, and the agent interprets it, writes code for it, runs it in the sandbox, and the gate verifies the answer.

**Request.** `POST /api/analyses {intent: "question", question: string (1–200 chars), snapshot_id}` → `{run_id}`. Budget and in-flight rules are the same as for other analyses. In-flight de-duplication is keyed on the normalized question.

**Stages.** `interpreting` → `planning` → `executing` → `validating` → (`repairing` → `executing` → `validating`) → `explaining` → completed | failed.
- **interpreting:** GLM 5.3 maps the question to a Plan or to `{"unsupported": "<short reason>"}`. It sees only the question, the published category and leaf ids with their titles, and this schema. Unsupported questions end the run as `failed` with error `unsupported_question` and the model's short reason (≤ 160 chars, validated: no digits beyond ids, no URLs).
- **planning:** GLM writes the program for the validated plan, exactly as for other intents.

**Plan** (closed vocabulary, validated with pydantic, extra fields forbidden):
```jsonc
{
  "group_by": "leaf" | "category",
  "scope_category_id": "cat_…" | null,     // restrict to one category (group_by must be "leaf" when set)
  "measure": "conversations" | "people",    // count conversations, or distinct people
  "signal": "any_friction" | "correction" | "repeat_request" | "assistant_limit" | "complaint" | null,
                                            // null = no filter; else count only rows where that signal is observed
  "rank_by": "count" | "share",             // share = count ÷ base, where base = same measure with no signal filter, per group
  "limit": 1..10
}
```
Other or unclear (`cl_other`, and the `is_other` category) never appears in question results.

**Result** (gate-validated, re-serialized canonically from the reference):
```jsonc
{"intent": "question", "snapshot_id": "snap_…", "plan": { …the validated plan, echoed exactly… },
 "rows": [{"id": "cl_…|cat_…", "count": 41, "base": 97, "share": 0.4227}],   // ordered by rank_by desc, then id asc; at most `limit` rows
 "total_count": 312, "total_base": 1051}    // over the whole scope, excluding Other
```
The gate checks exact schema, that `plan` equals the validated plan, allowlisted ids within scope, exact integers equal to the reference computed for this plan, shares within 1e-4, ordering, and length = min(limit, groups in scope).

**Run additions.** `Run.question: string | null` (sanitized echo) and `Run.plan: Plan | null`. Explanation placeholders are `{{rows.N.id}}` (rendered as the node's title), `{{rows.N.count}}`, `{{rows.N.base}}`, `{{rows.N.share}}`, `{{total_count}}` and `{{total_base}}`. The UI shows the interpreted plan in words before the result, e.g. "Distinct people · with repeated requests · within Build software · by workflow · top 5 by count".

**Attempt history (all analysis intents).** `Run.attempts_log: [{attempt: 1|2, code: string, code_sha256, receipt: Receipt | null, verdict: {passed, checks}, repair_reason: string | null}]` keeps every attempt. Code and receipts are never overwritten, so a repair stays visible. `repair_reason` comes from the fixed vocabulary only.

As implemented (backend): an entry is appended for every program version, including one the static pre-check rejected — that entry has `receipt: null` (it was never executed) and `verdict: {passed: false, checks: [{name: "Static pre-check", …}]}`. An execution that failed before the gate (non-zero exit, timeout, OOM…) has its receipt and the gate's fixed `{"Result file received": failed}` verdict. `repair_reason` is why that attempt did not pass — the same fixed-vocabulary lines the repair prompt gets (`"Static check: …"`, a trusted error category such as `"KeyError: the program used a column or key that does not exist"`, or `"Gate check failed: <check name>"`, joined with "; ") — and `null` when it passed. `attempt` numbers program versions while `Run.attempts` counts sandbox executions, so they differ when a version was rejected before execution. Story and containment runs have `attempts_log: []`.

**Gate as implemented (§0, backend).** No reference answer is computed. `Run.verdict.checks` lists, in order:
1. per-program checks, prefixed `"A · "` / `"B · "`: "Result file received", "Size within 1 MiB", "Strict JSON parse", "Document within structural limits" (depth ≤ 4, ≤ 20,000 values, lists ≤ 1,000, objects ≤ 32 fields, strings ≤ 64 chars), "Only allowlisted field names", "Only allowlisted string values", "Schema matches exactly", "Intent matches the request", "Snapshot id is the current snapshot", "Plan echoed exactly", "Ids are within the question's scope (no Other)" (also rejects duplicate ids), "Counts are non-negative integers", "count ≤ base and share = count ÷ base" (±1e-4), "Totals consistent with the rows" (total_count ≤ total_base; totals ≥ every row; for `conversations`, totals = the sum of all groups when every group is listed, ≥ the listed sum otherwise), "Ranked as the plan says (rank desc, then id)" (share compared as exact fractions of the program's own integers), "Row count is min(limit, groups in scope)" — or a single "Static pre-check" when the program was rejected before running;
2. run-level cross-checks against the published map, unprefixed, one line each over every program that reached them (detail "A and B: …" or "B: rows[0].base differs…"), only where derivable: "Consistent with the published map · base = published conversations" / "· base = published people" (base is unfiltered, so for every signal), "Consistent with the published map · count = published friction conversations" (or `correction` / `repeat-request` / `assistant-limit` / `complaint`; `conversations` with a signal only), "Consistent with the published map · totals = published scope totals" (`conversations`: sums of the in-scope published leaves; `people`: only when scoped to one category, against its `users`). A category row is cross-checked only if all of its leaves are in scope;
3. "Two independent programs agree" (canonical equality; details like "Programs disagree on row 3 · count").

Each `attempts_log[]` entry's own `verdict` holds that program's per-program checks (unprefixed) plus one summary line "Matches the published map" when cross-checks applied. The served result is the agreed sandbox output, canonicalized: keys in contract order, `share` recomputed from the program's own `count`/`base` and rounded to 4 dp. Live inputs are the typed rows frozen when the snapshot was published (`private.db.sandbox_inputs`, written by `save_cluster_map`), so later pipeline work can't make live answers drift from the published map.

Failure codes: `analysis_failed` (no valid, agreeing pair after the repair round), `map_mismatch` (A and B passed every per-program check and agree, but both disagree with the published map — the message names the cross-checks; typically the private data changed after publication), plus `unsupported_question`, `interpretation_failed`, `sandbox_unavailable`, `sandbox_invalid_response`, `model_unavailable`, `no_inputs`.

Programs and repair: A's system prompt requires pandas; B's forbids pandas/numpy (standard library only: csv, json, collections, …), and the static pre-check enforces B's import list. Both get the same plan-only prompt. One repair round regenerates only the programs that failed a check or crashed; if both passed on their own but disagree, both are regenerated. `attempts_log` entries carry `program: "A" | "B"` (normally A1, B1; after a repair also A2 and/or B2). Top-level `code`/`receipt` are program A's latest; `verdict` is the combined verdict.

Open-question details (backend):
- During `interpreting`, `Run.state` is `"planning"` (RunState is unchanged; the stage name carries it). The raw question reaches only the interpreting prompt; planning gets the validated plan, and the explanation gets the plan in words. `Run.question` is the sanitized echo (control characters removed, whitespace collapsed, ≤ 200 chars, emails/URLs/phone numbers/private ids/canary tokens replaced with `[removed]`).
- Errors: `unsupported_question` (message = the model's reason if it passes validation, else "This question can't be answered from the published aggregate counts."), `interpretation_failed` (two invalid plans, e.g. an unknown or Other scope). Semantics beyond the schema: `scope_category_id` must be a published, non-Other category; a scope with no groups is invalid.
- The echoed `plan` must contain all six keys (null stays null). Groups in scope include groups with zero rows. `count`/`base`/`total_*` for `people` are distinct pseudonyms (never summed). Ranking by `share` compares exact fractions, so rounding can't reorder near-ties; the gate requires the program's row ids to equal the reference's top rows in order.
- Gate check names added: "Plan echoed exactly", "Ids are within the question's scope (no Other)", "Row count is min(limit, groups in scope)", "Top rows ranked as the plan says (rank desc, then id)"; the shared checks (parse, structural limits, field/string allowlists, schema, intent, snapshot, non-negative, totals, counts, shares) also apply.
- `POST /api/analyses` with `intent: "question"` requires `question`; runs are de-duplicated on (snapshot, lower-cased whitespace-collapsed question) while in flight.

Presenter details (backend): the feature is off unless `PRESENTER_KEY` is set; the header is compared in constant time. Presenter requests skip the per-IP token buckets (they still have their own hourly budget: `PRESENTER_BUDGET_ANALYSES` 60, `PRESENTER_BUDGET_STORIES` 30, `PRESENTER_BUDGET_SEARCH` 300, `PRESENTER_BUDGET_CONTAINMENT` 30) and may use 2 run slots above the public in-flight cap.

**Presenter capacity.** Requests carrying header `X-Logless-Presenter: <PRESENTER_KEY>` draw from a separate budget (env `PRESENTER_BUDGET_*`), so anonymous traffic can't exhaust the stage demo. A wrong key is ignored silently and draws from the public budget. The web app reads `?presenter=<key>` once, keeps it in localStorage, and sends the header.

## 9. Runner API (sandbox VM, private VPC address only, port 8787)

Auth: `Authorization: Bearer $RUNNER_TOKEN` (token lives on the app VM and in the runner's systemd env; it is not a cloud credential).

- `POST /jobs` `{job_id (uuid), kind: "analysis"|"aggregate"|"containment", code: string (≤ 64 KiB), files: {name: string content} (≤ 8 MiB total; names only from assignments.csv, clusters.json, contract.json), timeout_s (0.5–10), memory_mb (128–512)}` → `202 {job_id, state}`. Idempotent on `job_id` (same id with a different job → `409`); queue full → `503`. Auth is checked in ASGI middleware on the headers alone, before any of the body is read (`401 {code, message}`); bodies over 10 MiB → `413` (declared or streamed).
- `GET /jobs/{job_id}` → `{job_id, kind, state: "queued"|"running"|"succeeded"|"failed"|"timed_out", exit_code, started_at, finished_at, elapsed_ms, timed_out, container_removed, runtime, image, output (string|null, content of /out/result.json ≤ 1 MiB), output_bytes, stderr_tail (≤ 2 KiB; backend-only, used for the repair prompt, never forwarded to the browser), limits, error (fixed code or null: timeout, nonzero_exit, oom_killed, no_output, output_too_large, output_not_regular_file, too_many_output_files, output_unreadable, not_utf8, bad_output_frame, container_create_failed, image_missing, image_digest_mismatch, runtime_unavailable, runner_error, cleanup_failed), host, code_sha256}`. A job becomes terminal only after its container is removed and the removal verified; if removal cannot be verified the job is `failed` with `error: "cleanup_failed"` and no output, and the runner quarantines itself (new jobs → `503 {code: "quarantined"}`, queued jobs wait, `/health` → `degraded` with `quarantined: n`) until a reconcile loop (every 5 s) confirms the container is gone; labelled orphans not belonging to a running job are also swept every minute. Results are kept in memory for 15 min. The app validates every response strictly (enumerated states/errors/runtimes, bounded integers, ISO timestamps, no extra fields, `job_id` and `code_sha256` must match the submission) and treats anything else as `sandbox_invalid_response`.
- `GET /health` (no auth, no config values) → `{status: "ok"|"degraded", quarantined, runtime, image ("logless-analysis:1@sha256:<image id>"), docker (server version or "unreachable"), queued}`.

Container: image `logless-analysis:1` pinned by digest, `--runtime=runsc --network=none --read-only --tmpfs /tmp:size=64m,nr_inodes=1024 --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=64 --memory=512m --memory-swap=512m --cpus=1 --user 10001:10001 --ulimit core=0 --ulimit nofile=256 --log-driver=none`, default seccomp, `/in` read-only (allowlisted filenames only), `/out` a size-capped writable mount (≤ 2 MiB, ≤ 16 inodes), command `python /in/main.py`, label `logless.job=<job_id>`. Collect only a regular file `/out/result.json` (no symlinks, no FIFOs, ≤ 1 MiB). stdout/stderr are captured through bounded pipes (≤ 64 KiB).

As implemented (`runner/`): `/out` is `--tmpfs /out:size=2m,nr_inodes=16,mode=0700,uid=10001,gid=10001`. A tmpfs is gone once the container stops (verified: `docker cp` after exit finds nothing), so `/in/main.py` is a runner-owned bootstrap that runs `/in/program.py` as a child process (its stdout redirected to stderr), then — only if it exited 0 — opens `/out/result.json` with `O_NOFOLLOW`, requires `S_ISREG`, ≤ 1 MiB and ≤ 16 entries in `/out`, and writes it to the real stdout behind a one-line frame `LOGLESS/1 <status> <exit> <bytes>`. The frame is transport, not a trust boundary; the gate validates everything. gVisor's tmpfs ignores `nr_inodes` (the 2 MiB size cap holds), so the ≤ 16-entry rule is enforced by the bootstrap under runsc. The image is run by its content id (`sha256:…`, optionally pinned via `RUNNER_IMAGE_DIGEST`); the docker CLI gets a minimal environment (no `RUNNER_TOKEN`). The supervisor kills and removes the container at the deadline, removes it after every run, and reaps labelled orphans on start. Locally (macOS) the runner may use `runc` with the same flags; it reports the runtime it used.

## 10. Environment variables (see `.env.example`)

App VM / local backend: `VULTR_INFERENCE_API_KEY`, `TYPESAFE_API_KEY`, `FIREWORKS_API_KEY`, `PSEUDONYM_SALT`, `RUNNER_URL`, `RUNNER_TOKEN`, `LOGLESS_DATA_DIR`, `SAMPLE_SIZE`, `SAMPLE_SEED`, `LOGLESS_ENV` (`production` on the app VM: disables the dev CORS origin `http://localhost:5173` and makes `backend/scripts/dev_snapshot.py` refuse to run). Optional: `LOGLESS_BUDGET_SEARCH_PER_HOUR` (600), `LOGLESS_BUDGET_ANALYSES_PER_HOUR` (120), `LOGLESS_BUDGET_STORIES_PER_HOUR` (60), `LOGLESS_BUDGET_CONTAINMENT_PER_HOUR` (60), `LOGLESS_SEARCH_CONCURRENCY` (4), `SANDBOX_IMAGE` (`logless-analysis:1`), `SANDBOX_IMAGE_DIGEST` (the sandbox image id, shown in receipts when the runner reports exactly it), `SANDBOX_HOST_LABEL` (`logless-sandbox`), `PRESENTER_KEY` (random; unset = presenter capacity off), `PRESENTER_BUDGET_ANALYSES` (60), `PRESENTER_BUDGET_STORIES` (30), `PRESENTER_BUDGET_SEARCH` (300), `PRESENTER_BUDGET_CONTAINMENT` (30).
Sandbox VM: `RUNNER_TOKEN`, `RUNNER_BIND` (private IP:8787), `RUNNER_RUNTIME` (`runsc`); optional `RUNNER_IMAGE` (default `logless-analysis:1`), `RUNNER_IMAGE_DIGEST` (expected image id; set on the VM — update or remove it after rebuilding the image, or the runner refuses jobs), `RUNNER_WORK_DIR`, `RUNNER_CONCURRENCY` (2), `RUNNER_RESULT_TTL_S` (900).
Operator machine only: `VULTR_API_KEY` (in `.env.ops`, never on a VM).

## 11. Live intake (presenter-only, real incremental update)

Purpose: show the pipeline working on *new* conversations in real time, and really update the published map. It is not a canned animation.

**Prepare (operator CLI, before the demo):** `logless intake prepare --n 300 [--seed S]`
1. Picks N conversations from the pinned WildChat shard that aren't in the sample: eligible rows, minus the sampled `source_row`s, chosen with a seed.
2. Stores them in `private.db.conversations` with a new column `intake_batch` (batch id). They are not part of any snapshot until ingested.
3. Runs GLM facets plus the PII check and rewrite for them now; this is the slow, rate-limited part.
4. Marks the batch `ready`, and records the base snapshot id it was prepared against.

Friction and theme are not decided at this step. Other commands: `logless intake status` and `logless intake reset`.

**Run:** `POST /api/intake/runs {}` requires a valid `X-Logless-Presenter` header and returns `{run_id}`. Errors: 403 `presenter_required`, 409 `intake_not_ready` or `intake_in_flight`. The run kind is `"intake"`. Stages:
1. `deciding`: one Jev call per conversation with 5 questions, the 4 friction signals plus a theme Choice over the current snapshot's leaves and "Other or unclear". 24-way concurrency, cutoff 0.65.
2. `filing`: store the assignments and friction decisions.
3. `gating`: the privacy gate plus invariants and leak scans on the updated snapshot. Texts come unchanged from the base build; only metrics change.
4. `publishing`: an atomic new snapshot with the base build's texts and metrics recomputed by the pipeline's trusted code over base plus batch conversations. The `sandbox_cluster_map` is saved so live questions work on it.
5. `evaluating`: the eval report for the new snapshot is regenerated in the background.

**Events:** `GET /api/intake/runs/{run_id}/events?after=<seq>` returns up to 200 events per call. The browser polls about every 300 ms.
```jsonc
{"run_id": "run_…", "state": "running|completed|failed", "stage": "deciding|filing|gating|publishing|evaluating|done",
 "counters": {"total": 300, "decided": 187, "per_second": 46.2, "p50_ms": 241, "decisions_per_conversation": 5},
 "events": [{"seq": 188, "t_ms": 3912, "leaf_id": "cl_…", "p": 0.93,
             "friction": {"correction": "observed", "repeat_request": "not_observed", "assistant_limit": "not_observed", "complaint": "not_observed"},
             "language": "Chinese", "turns": 3,
             "summary": "Fix an error when loading a trained model"}]}   // summary: null → "summary withheld"
```
- `summary` is the conversation's generalized facet `task` sentence, at most 90 characters. It is present only if it passed the PII check and the API leak scan (emails, URLs, phones, private ids, canary tokens, contact patterns).
- There are no conversation ids, user ids or raw text anywhere in the events.
- `leaf_id` is `cl_other` below the cutoff.

**Completion:** `Run.intake = {batch_size, decided, other, published_snapshot_id, base_snapshot_id, deltas: [{id, conversations_before, conversations_after, friction_share_before, friction_share_after}]}`, top 8 by absolute change.

**Other endpoints:**
- `GET /api/intake/status` (public) returns `{ready, batch_size, base_snapshot_id}`. The UI shows the control only when a batch is ready and a presenter key is stored; the server enforces the key.
- `POST /api/intake/reset` (presenter only) re-publishes the base snapshot and clears the batch's decisions, so the demo can be rehearsed.

**Product copy:** "Live intake shows a generalized, PII-checked one-line summary for each new conversation as it is classified. Transcripts are never shown."

**Backend notes (as implemented, `backend/logless/intake.py` + `backend/logless/api/intake.py`):**
- The events response also carries `intake` (the completion object above) once `state` is `completed`, and `error: {code, message}` if it failed. `stage` becomes `done` when the background evaluation finishes. Events live in the API process's memory; after a restart the endpoint serves the persisted Run record with no events.
- The Run record is stored in `public.db.runs` with kind `"intake"` and the usual Run fields (`intake` set on completion). While it runs, `state` is `executing` (a valid RunState); the events payload uses `running`.
- Batch decisions are stored like the pipeline's own: friction rows with `FRICTION_QV`, and assignments under the base snapshot's build with `round = 100`. A leaf's first private theme id is used; below the cutoff the theme is `other`. So `pipeline.stats` and the sandbox export (`save_cluster_map` freezes the rows for the new snapshot) cover base plus batch without special cases. A conversation whose Jev call fails twice is filed as Other with friction `unclear` (never guessed), and it emits no event.
- Intake Jev calls bypass the response cache (no reads and no writes), so every rehearsal is live.
- The gating stage re-runs the deterministic privacy checks on every published text (short titles included), with the corpus now including the batch. It also runs the publish invariants (strict ranges for full builds), the payload scans and the API `serialize_snapshot`. Any failure rolls back the batch's decisions, and the base snapshot stays live.
- `logless rebuild` never includes intake conversations (`conversations.intake_batch IS NULL`). An intake snapshot resolves to its base build for `eval` and `--from-stage`. `prepare` refuses while an intake snapshot is live, and replaces any previous batch.
- CLI: `logless intake prepare [--n 300] [--seed S]`, `logless intake status`, `logless intake reset`.
