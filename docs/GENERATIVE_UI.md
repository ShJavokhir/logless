# Loggy's answer canvas

Completed, checked answers now get a visual composition rendered by json-render.
Jev selects and orders up to three prepared components: ranked bars, workflow
cards, a friction plot, signal breakdowns, and published needs/problems.

The **Change this view** input edits the presentation of the current answer.
For example: “Show cards”, “Put the signals first”, or “Show only ranked bars”.
**Previous view** restores the preceding composition without a provider call.
Up to ten versions remain available while the answer is open.

Use **Ask another** for a new analytical question. This release does not add
multi-turn analytical context, new topic groupings, time comparisons, or new
capability measurements. The existing analysis planner still defines which
questions can be answered. A needs board shows published evidence to investigate;
it does not claim that each problem proves an absent feature.

## Try the interface without keys

From the repository root:

```sh
cd web
pnpm install --frozen-lockfile
VITE_MOCK=1 pnpm dev
```

Open `http://localhost:5173/#/explore`.

1. Select **Ask a question**.
2. Ask “Which coding workflows have the most distinct people repeating requests?”
3. Wait for the answer and its canvas.
4. Select **Show cards**, then open a workflow card. Its detail should open on the map.
5. Select **Compare friction**. Check the plot and each workflow's signal counts.
6. Select **Explore needs**. Check the published needs and recurring problems.
7. Enter “Show only ranked bars” in **Change this view**.
8. Select **Previous view**. The preceding composition should return.

Mock mode explicitly says **Demo layout · no Jev call**. It uses deterministic
example choices to exercise rendering and navigation, not a decision model.
Use `?gate=fail#/explore` to verify failed analyses never receive a canvas.

## Test real Jev composition

Use the normal live backend and sandbox configuration described in `README.md`.
The backend needs its published snapshot, checked analysis runs, and existing
`TYPESAFE_API_KEY`. Creating a new live analysis also needs the GLM provider and
sandbox runner. Never place keys in a `VITE_` environment variable.

In one terminal, from the repository root:

```sh
cd backend
uv sync --locked --extra dev --python 3.12
uv run logless serve
```

In another terminal, from the repository root:

```sh
cd web
VITE_MOCK=0 pnpm dev
```

Repeat the interface steps. After composition, the label should read
**View composed by Jev**. In browser Network tools, inspect `POST /api/canvas`:

- The request contains `snapshot_id`, `run_id`, `instruction`, and the previous
  candidate IDs. It never supplies result data, code, a URL, or a UI spec.
- A successful response has `status: "composed"`, selected IDs, and a bounded
  json-render spec. The selections can differ from mock mode.
- “Only health, last week” requires new data. The endpoint should return
  `needs_analysis`; the UI retains its existing view and directs you to a new question.
- Remove the TypeSafe key in a disposable local backend and restart it to test
  provider failure. The checked ranking remains visible with a standard-view label.
  An edit failure retains the previous view and explains that it did not update.
- An old snapshot, an unfinished/failed run, extra request fields, and unknown
  candidate IDs are rejected before composition.

The endpoint has a separate per-IP bucket, four concurrent-call slots, an
eight-second provider timeout with no retry, and hourly budgets:
`LOGLESS_BUDGET_CANVAS_PER_HOUR` (default 120) and
`PRESENTER_BUDGET_CANVAS` (default 60).

## Implementation and boundaries

```text
Checked analysis + published snapshot
                 |
        Prepared component candidates
                 |
       Native Jev choices (one call)
                 |
       Code constructs a bounded spec
                 |
       Client validates IDs and structure
                 |
       json-render renders React components
```

The [Jev guide](https://json-render.dev/docs/jev) describes an unreleased
experimental composer. Two integration paths were considered:

- Build its source packages and add a Node/Gateway service beside FastAPI.
- Use its prepared-candidate pattern with the existing native Python Jev adapter
  and the published React renderer.

This implementation uses the second path. It needs no Gateway account or
additional service. `@json-render/core` and `@json-render/react` are pinned to
`0.21.0`. It does **not** use or claim compatibility with
`experimental_composeSpec` or `experimental_createEvaluator`.

Jev chooses component membership and order. Component code supplies every value
from the checked result or published snapshot. Empty component props prohibit
model-authored numbers, prose, expressions, URLs and actions. The client also
rejects extra nodes, unknown components, event handlers, cycles, and responses
for another run or snapshot before rendering. Workflow links call existing app
handlers using published IDs.

Rankings and card counts use the checked question result. Friction charts and
signal breakdowns use the published conversation metrics for the returned
groups, even when the question counts people or filters a signal. The views
label this distinction. Signals can overlap. Needs under a category come from
its published child workflows and have no fabricated per-need counts.

The implementation is intentionally bounded. It does not generate arbitrary
React, execute generated actions, stream partial trees, or expose conversations.
Composition quality still depends on Jev and needs live evaluation; typed output
does not establish analytical correctness.

## Automated checks

From `web/`:

```sh
pnpm test
pnpm build
pnpm lint
```

From `backend/`:

```sh
uv run pytest tests/test_canvas.py tests/test_api_app.py tests/test_provider_validation.py tests/test_api_body_limit.py -q
```

The new tests cover bounded composition, malformed/provider-error fallback,
new-analysis detection, API publication gates, unchanged checked results, hostile
spec rejection, StrictMode request coalescing, workflow links, and view history.
Provider calls in automated tests use fakes. They do not verify live Jev quality.
