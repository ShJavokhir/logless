# Synthetic classification and semantic zoom

The existing WildChat path remains available. The synthetic path implements the three-signal contract
in `docs/spec.md`, using GLM 5.3 on Vultr for abstraction/discovery and Jev for classification.

## Approach

Changing the WildChat stages in place would share more code but also change their four-signal data model.
A separate synthetic rebuild command reuses the provider clients, database publication, and public API.
Its own immutable taxonomy versions prevent mixing assignments across changed membership rules.

The map uses a stable packed-circle layout and a 420 ms SVG camera transition. Adding Lenis would affect
page scrolling without improving category/workflow selection. Search and friction styling do not change geometry.
Reduced motion bypasses animation. Breadcrumbs and Escape return through workflow, category, and overview.

## Run

```sh
uv venv --python 3.12 backend/.venv
uv pip install --python backend/.venv/bin/python -e './backend[dev]'
backend/.venv/bin/python -m logless.synthetic seed
# Set TYPESAFE_API_KEY and VULTR_INFERENCE_API_KEY server-side in .env or development .env.local.
LOGLESS_DATA_DIR=./var-synthetic backend/.venv/bin/python -m logless.synthetic rebuild
# Optional representative pilot spanning the source corpus:
LOGLESS_DATA_DIR=./var-synthetic backend/.venv/bin/python -m logless.synthetic rebuild --limit 48
# Review unclear goals; if taxonomy changes, reclassify ALL pilot/corpus interactions:
LOGLESS_DATA_DIR=./var-synthetic backend/.venv/bin/python -m logless.synthetic rebuild --evolve
LOGLESS_DATA_DIR=./var-synthetic backend/.venv/bin/logless serve --port 8000
LOGLESS_API_ORIGIN=http://127.0.0.1:8000 npm run dev
# Or run beside an existing preview without sharing Next's build directory:
LOGLESS_DATA_DIR=./var-synthetic backend/.venv/bin/logless serve --port 8001
LOGLESS_API_ORIGIN=http://127.0.0.1:8001 LOGLESS_BUILD_DIR=.next-synthetic npm run dev -- --port 3001
```

The rebuild CLI defaults to `var-synthetic/`. Use that data directory explicitly for the API.
A rebuild refuses to replace a non-synthetic snapshot. No provider error falls back to mock data.
A failed candidate leaves the previous published snapshot active. Restart Next.js after changing the API origin.
Do not overwrite an existing local server's environment to switch datasets; use another port when needed.

Vultr's account API key and inference API key are different credentials. Use the account key only for
`GET https://api.vultr.com/v2/inference/{subscription-id}` to obtain the subscription's inference key.
The application needs only `VULTR_INFERENCE_API_KEY`. Its completion endpoint is
`https://api.vultrinference.com/v1/chat/completions`, with `model: glm-5.3` and `max_completion_tokens`.
The public model catalog alone does not verify a credential. A real completion did: HTTP 200 in 1,304 ms.

## Data flow

```
private source messages + tool events
  -> GLM batches of 20 -> private goal/outcome/evidence abstractions
  -> GLM discovery batches covering the entire corpus -> consolidated taxonomy
  -> frozen taxonomy hash (names, rules, exclusions, hierarchy)
  -> Jev: one primary leaf + three independent tri-state questions per abstraction
  -> code computes counts, friction unions and distinct people
  -> validation + atomic publication -> public snapshot
```

The three friction questions cover correction, task complaint, and unresolved action error.
Their independent outcomes are observed, not observed, or unclear. Low **confidence** becomes unclear;
this uses TypeSafe's distribution-concentration field, not the top class probability. The default 0.65
cutoff is a heuristic, not an accuracy or privacy guarantee. The actual model, probabilities, confidence,
question version, taxonomy version, timings, and token usage are retained privately.

Every source conversation keeps one assignment, including Other or unclear. Identical abstractions can
share inference, but aggregation expands decisions back to all conversations. Signal counts overlap;
friction counts their union. Distinct people are recomputed per category and total, never summed.

The default concurrency is four, capped at sixteen; GLM concurrency is capped at four. Only a bounded
wave is scheduled. Provider failures stop further scheduling. Transport retries and GLM schema repairs
are bounded. Completed abstraction/discovery/decision artifacts support resumption.
Mapping uses low reasoning and up to three generalization attempts. A failed generalization check stops
publication; it never removes a failed interaction from the denominator. Each published run retains a report.

`--evolve` sends only unclear abstractions plus the prior taxonomy to GLM. A changed taxonomy receives a new
content hash. All interactions are reclassified, including previously clear assignments. Prior versions
remain in private artifacts. If unchanged, cached decisions are reusable. New snapshots invalidate search caches.

## Publication and API

`var-synthetic/` contains private artifacts and is gitignored. The browser receives no source IDs,
fictional-user links, private abstractions, labels, full decisions, credentials, or taxonomy membership rules.
The existing allowlist serializer emits generalized cluster summaries and computed metrics. Deterministic
canary/contact/identifier checks reject unsafe model text before publication. These checks are limited;
this is not validation for private customer data or a complete implementation of the spec's privacy audit.

The existing `/api/search` batches a separate Choice relevance question for every published leaf. It sends
only the query, public titles, and public descriptions. It supports no matches, cache invalidation by snapshot,
request deduplication, bounded concurrency, request budgets, stale-snapshot rejection, and timeout errors.
The UI debounces requests and ignores superseded responses. Counts stay tied to the original snapshot.
When publication makes the browser's snapshot stale, a Load latest insights action reloads it and repeats
the current search. Old selections and analysis results are cleared together.

The new synthetic aggregation uses trusted Python code. It does **not** yet export the older sandbox input
bundle or run that aggregation in the sandbox. The UI shows published counts and disables Refresh finding
for synthetic snapshots; the API rejects their live analysis requests explicitly. WildChat live analysis
is unchanged. This prevents a synthetic snapshot from implying a sandbox execution that did not happen.
Story generation continues through the existing server API, subject to its provider setup and privacy checks.

## Verify

```sh
backend/.venv/bin/python -m pytest backend/tests/test_synthetic_pipeline.py backend/tests/test_api_serializers.py
LOGLESS_DATA_DIR=./var-synthetic backend/.venv/bin/python -m logless.synthetic.verify
npm run check
npm run build
```

The live probe measures nine representative abstractions against a fixed evaluation taxonomy, plus one
matching and one unrelated search. It does not replace an end-to-end GLM rebuild. Its report is saved in
`var-synthetic/synthetic/live-verification.json`. A rebuild saves its own report next to private artifacts.

Sources: [Applied Compute trace analysis](https://www.appliedcompute.com/platform/billion-token-scale-trace-analysis),
[TypeSafe API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice),
[parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions), [confidence](https://docs.typesafe.ai/confidence).
Vultr sources: [Inference API](https://api.vultrinference.com/),
[subscription authentication flow](https://docs.vultr.com/public/doc-assets/pdfs/collection_item/products-serverless-inference.pdf).

## Measured in this session

The live Jev probe used `jev-1.13.0`, nine authored regression cases, four independent Choice questions
per case, three concurrent requests, and a confidence cutoff of 0.65. Calls were uncached, from this Mac.
The rubric was adjusted on these same cases; this is regression evidence, not a held-out accuracy estimate.

| Measurement | Result |
| --- | --- |
| Initial rubric | 31 / 36 decisions matched expected labels |
| Revised rubric | 35 / 36 decisions; 8 / 9 complete records |
| Latest revised probe latency | median 125 ms, nearest-rank p95 339 ms (nine requests) |
| Latest whole probe, including searches | 865 ms |
| Full 600-conversation rebuild | 118.245 s; 150 fictional people; 28 days |
| Full-corpus Jev requests | 560 unique abstractions, four questions each, concurrency four |
| Full-corpus Jev latency | median 142 ms, nearest-rank p95 221 ms; fresh requests only |
| Live matching search through Next/API | 183 ms wall time; 169 ms provider; correct group-coordination cluster |
| Live unrelated search through Next/API | 172 ms wall time; 164 ms provider; zero matches |
| Taxonomy review | 4.111 s; unchanged taxonomy; 600 decisions reused |
| Cached resume | 148 ms; no new model requests |
| Synthetic category zoom | 499 ms including browser automation overhead |
| Synthetic workflow zoom | 537 ms including browser automation overhead |

The remaining classifier disagreement is conservative: a task complaint gives `unclear` for correction
instead of expected `not_observed`. Both the recovered-action case and changed-preference case pass.
Circle coordinates and radii were identical before and after workflow zoom. Keyboard entry, Escape,
breadcrumb return, category/workflow details, and a 390-pixel viewport were exercised in the browser.
Reduced-motion behavior is implemented through the media query but has not been exercised under a changed OS setting.

The published taxonomy is `tax_2749be1d52fe3c9d`: four categories, eleven named workflows, and Other or
unclear. All 600 primary assignments reconcile. The one unknown-goal fixture is the only Other assignment.
Every authored goal family maps consistently to an appropriate workflow, including meeting coordination
and group outings sharing one workflow. Friction is observed in 227 conversations; 94 have only unclear signals.

Against the template generator's labels, 1,639 of 1,800 friction decisions match. All 227 expected observed
signals were detected. Most disagreements are conservative unclear decisions; some generic claims of an
unspecified action lack enough evidence to imply an external action. These generated labels and the highly
templated corpus are not an independent accuracy benchmark. Nine more explicit regression cases are measured above.

The first full attempt was blocked when an abstraction repeated a synthetic identifier; the existing pilot
stayed published. After tightening the map prompt and using low reasoning, all batches passed without a
generalization retry. The real evolution review retained the taxonomy because the sole unclear goal provided
no evidence for a new theme. Rule-changing reclassification, unchanged lineage, and failed publication rollback
are covered by integration tests with provider test doubles.

Latest checks: 171 backend tests passed; 19 frontend tests and type checking passed; the production build passed.
An earlier run exposed an intermittent failure in the unchanged WildChat worker-pool test; two later full runs
passed. No configured API keys appeared in the 44 checked browser build artifacts. No deployment or push was made.

The current local preview is http://127.0.0.1:3001 with its API on port 8001. Private reports and decisions stay
in `var-synthetic/`; the browser receives only the allowlisted snapshot. Synthetic live sandbox refresh and a
full private-customer privacy audit remain outside this implementation.
