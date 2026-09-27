# Live smoke test

Python 3.10+; standard library only. Run from the repository root:

```sh
./scripts/smoke_live.py --skip-paid
./scripts/smoke_live.py --skip-paid --json
./scripts/smoke_live.py --self-test
```

The default deployment is `https://144-202-110-2.sslip.io`. `--skip-paid` makes
health, snapshot, and evaluation GETs and at most one search POST. It never
submits analyses, containment checks, or stories. The self-test uses canned
payloads for both API versions and never contacts the deployment. It normally
runs a local `http.server`; if the environment denies loopback socket binding,
it runs the same handler with serialized HTTP requests and responses in memory
and reports that fallback explicitly.

Omitting `--skip-paid` enables all eight checks and consumes live budgets:

```sh
./scripts/smoke_live.py --base-url https://144-202-110-2.sslip.io \
  --presenter-key-env LOGLESS_PRESENTER_KEY --timeout 90 \
  --question 'Which coding workflows have the most distinct people repeating requests?'
```

If the named environment variable is set and nonempty, its value is sent as
`X-Logless-Presenter`. The script never prints the key or raw response bodies.
Redirects are rejected so this header cannot be forwarded to another origin.

Each check prints its result, a one-line detail, and elapsed seconds. `--json`
instead emits one JSON object with checks, metrics, version evidence, counts,
and the exit code. Exit status is **1** if any check fails, **0** otherwise
(including budget skips); invalid CLI arguments exit **2**. HTTP 429
`budget_exhausted` and `rate_limited` produce `SKIPPED: budget`, with
`status: "SKIPPED"` and `reason: "budget"` in JSON. Skips do not prove the
skipped feature works. Requests are not automatically retried.

The script always submits `intent: "question"`, which both deployment versions
support. Labeled attempt history confirms the new `question-only` API and
requires both A and B to have `runsc` receipts. Unlabeled history identifies
the `legacy` API; optional history/timings may be missing. Snapshot
`provenance.stats_source` presence/absence provides a provisional version hint
when paid runs are skipped. Missing evidence is reported as `unknown`; free
checks cannot conclusively distinguish a partial deployment.

The snapshot check walks keys and values for private IDs, emails, and URLs;
only dataset/source URLs inside `dataset` are exempt from the URL check.
The eval check requires the current snapshot's report and reports scored
targets met (null/informational checks are excluded from the denominator).
An unmet eval target is reported but does not itself fail report availability.

Run polling waits one second between nonterminal responses. `--timeout`
applies separately to each run, including submission and polling; story
retrieval shares one deadline across pending responses. Individual HTTP
requests have a maximum 15-second socket timeout, bounded by the remaining
run deadline. New-API sandbox timings sum executed attempts per program,
including repairs; gate-check counts come from the final verdict. Story word
counts match the backend and exclude inline evidence markers.
