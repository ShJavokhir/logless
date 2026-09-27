# Live smoke test

Python 3.10+; standard library only. Run from the repository root:

```sh
./scripts/smoke_live.py --skip-paid
./scripts/smoke_live.py --skip-paid --json
./scripts/smoke_live.py --self-test
```

The default deployment is `https://144-202-110-2.sslip.io`. `--skip-paid` makes
health, snapshot, and evaluation GETs only. It never submits search, analyses,
containment checks, or stories; an uncached search also makes a paid Jev call. The self-test uses canned
payloads for both API versions and never contacts the deployment. It normally
runs a local `http.server`; if the environment denies loopback socket binding,
it runs the same handler with serialized HTTP requests and responses in memory
and reports that fallback explicitly.

Omitting `--skip-paid` enables all eight checks and consumes live budgets:

```sh
./scripts/smoke_live.py --base-url https://144-202-110-2.sslip.io \
  --presenter-key-env LOGLESS_PRESENTER_KEY --timeout 90 \
  --question 'Which workflows have the most distinct people repeating requests?'
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
support. Labeled attempt history identifies the new `question-only` API. Modern
analysis passes only when all of the following reported evidence is consistent:

- A and B each finish with a successful `runsc` execution, nonempty output,
  verified removal, isolated network/read-only root and positive resource limits.
- Each executed attempt has timing, ordered timezone-aware timestamps, a distinct
  job ID and a receipt hash matching the SHA-256 of its returned program source.
  The run's execution count equals its receipts. Earlier failed executions and
  static rejections are allowed when followed by a valid repaired version.
- Both final program verdicts contain all 16 core gate checks. The combined
  verdict includes those checks for A/B, a published-map check and explicit
  program agreement; every final check must pass, with no contradictory flag.
- Run and result match the requested snapshot and plan. Result IDs, scope,
  counts, totals, shares and ordering satisfy basic consistency checks. Share
  ranking uses exact fractions, not the rounded display values.

For an explicitly historical deployment, use `--legacy` to enable the reduced
legacy path. Historical snapshot `provenance.stats_source` alone is only a hint
and cannot relax the evidence checks.
Legacy mode permits optional history/timings and checks the historical receipt
shape; it does **not** establish modern dual-program verification. A modern run
with labeled history is checked strictly even if `--legacy` was supplied.
Missing/unlabeled history alone cannot silently downgrade a modern/unknown
deployment. Snapshot provenance provides only a provisional version hint
when paid runs are skipped; free checks cannot conclusively distinguish a
partial deployment.

Modern containment additionally requires the destructive command's reported
removal, containment and clean-next-run flags, a passing follow-up, a runaway
receipt consistent with its timeout/deadline, and leak-rejection names matching
the actually failed gate checks. The destructive fixture's own `root_read_only`
and `binaries_intact` reports are untrusted informational fields, so they cannot
substitute for those outside checks. Legacy containment is explicitly labeled
`legacy partial evidence` (`evidence_scope: "legacy_partial"` in JSON).

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

This is a consistency smoke test of API-reported evidence, not independent host
attestation or a rerun of private-data computations. It cannot prove that
classification labels are correct, that two program outputs have no shared bug,
or that a dataset represents real users accurately. It does not test imports or
intake. Search and story checks cover response shape/references rather than
semantic accuracy. In particular, exit status 0 with five skipped checks, or an
available evaluation report with unmet targets, is **not** full product readiness.
