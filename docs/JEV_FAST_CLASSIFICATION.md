# Prepared-summary Jev classification

Implemented as an opt-in private pipeline path. **The 10,000-summary target is unverified.**
The requested prepared workload does not exist yet (confirmed by the operator).
No 10,000-item live run or representative accuracy estimate has been produced.
The existing transcript classifier remains the default until this path qualifies on real inputs.

## Decision and current contract

Checked the TypeSafe skill installed in the Technical Advisor project and current official docs on 2026-09-27:

- [API](https://docs.typesafe.ai/api): question IDs are returned unchanged; IDs are not inference instructions.
- [Models](https://docs.typesafe.ai/models): pinned `jev-1.13.0`, 255 Choice options, 64k total input and 32k state plus longest question; 250,000 input tokens/second and 1,200 requests/minute. Limits may change.
- [Choice](https://docs.typesafe.ai/primitives/choice) and [fan-out](https://docs.typesafe.ai/patterns/fan-out): independent questions share state and run in parallel. Extra questions still consume tokens.
- [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions): a useful batching example, not a measurement of this workload.
- [Model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): unrelated state and unnecessary indirection can reduce quality.
- [Confidence](https://docs.typesafe.ai/confidence): provider confidence and highest-option probability are different quantities.

Two approaches use identical decision wording and complete taxonomy definitions:

| Approach | Request shape | Trade-off |
| --- | --- | --- |
| Single summary | One Choice and the full taxonomy per request | Simple isolation; repeats taxonomy. At 20 requests/second, 10,000 requests need about 500 seconds. |
| Shared taxonomy | Full taxonomy once as state; one summary inside each independent Choice's structured instructions | Amortizes definitions and requests. Short option keys require one reference to the shared taxonomy, so accuracy must qualify against labels. |

The provisional selection is shared taxonomy. Putting every summary into shared state would expose each decision to unrelated chats. Instead, only the taxonomy is shared. Stable source summary IDs remain question IDs, and each question explicitly includes its own summary. Local option keys (`t0`, etc.) map to frozen theme IDs in the stored taxonomy. Names, descriptions, includes, and excludes are preserved without shortening.

```text
prepared summaries + frozen taxonomy
           |
     validate and pack
           |
 bounded async workers <-> rate gate / retry-after
           |
 validate answers, probabilities, model and usage
           |
 private SQLite transaction: assignments + evidence + run
           |
 reread and verify exact coverage; stop end-to-end clock
```

## Behavior and privacy

`logless.pipeline.fast_classify.classify_prepared` creates a fresh build/run ID and stores assignments in `private.db`. It never reads raw transcripts, publishes a snapshot, changes an existing build, or adds a browser endpoint. Summaries go to TypeSafe for classification. This is the existing server/provider privacy boundary, not on-device processing.

The legacy decision rule remains: the explicit **Other or unclear** option or a highest-option probability below **0.65** becomes `other`. Empty and ambiguous summaries may take that path. Exhausted request errors also become `other` with probability zero and an explicit error record; they invalidate success. Account failures stop the run and never fabricate completed assignments.

Private evidence records retain raw choice, top probability, provider confidence, returned model, batch mapping, and errors. Private run records retain taxonomy/input hashes, frozen taxonomy definitions, question version, request bytes, token usage, each attempt's start and duration, statuses, retry delays, and storage timing. Logs and CLI output contain aggregate diagnostics only. Neither request nor response cache is used.

Exact input ID coverage is checked before storage and after commit. Duplicate input IDs, JSON keys, answer IDs, missing/extra answers, invalid distributions, unexpected models, and invalid token usage fail validation. All assignments and evidence commit together.

## Limits, rate control, and timing

- Packing uses conservative UTF-8 byte estimates plus framing allowances, capped at 60k total and 30k state plus longest question. TypeSafe does not publish an exact tokenizer. These admission estimates are **not measured token counts** and are not proof of hidden tokenizer behavior. Actual API usage remains separate. Oversized single inputs fail before requests; no truncation occurs.
- Request starts are paced to 20/second. Concurrent requests are bounded (default 24). A rolling one-second token gate covers initial requests and retries.
- The full benchmark calibrates token pacing from the selected live pilot's largest measured token/byte-bound ratio, plus 25% headroom. It raises reservations when actual usage exceeds predictions. Context packing stays conservative. This is a rate estimate; server 429s remain authoritative. Standalone library calls default to conservative pacing.
- Transient failures retry with exponential backoff and jitter. Both numeric and HTTP-date `retry-after`, and `retry-after-ms`, are honored without shortening the delay. A 429 or 529 pauses all workers. Permanent errors do not retry.
- Run one benchmark per API key at a time. Other clients sharing the account consume its limits; this process cannot coordinate their budgets.
- Preparation and HTTP client construction are reported separately. The requested interval starts immediately before the first POST and ends after all assignments commit and pass the database reread. Retry time, rate waits, validation, and assignment storage are included. Updating the final timing report follows that interval.
- Actual tokens from all responses, including retried malformed results, are counted. Failed requests may omit usage; `attempts_without_usage` identifies that uncertainty. No zero-cost assumption is made for those attempts.
- Every run uses fresh state containing a nonce and sends `Cache-Control: no-cache`. The public API does not expose a provider-cache bypass guarantee or a standard cache-hit field. Local cold-cache behavior is verified; provider-internal caching is not independently observable. Known reported cache hits disqualify the target flag.

## Benchmark command

Use backend Python 3.12. Prepare private files:

- `summaries.jsonl`: one object per line, exactly `{"summary_id":"s001","summary":"..."}`. IDs are stable ASCII letters/digits, `_` or `-`, up to 128 characters. Empty summary text is allowed for catch-all evaluation.
- `taxonomy.json`: a frozen array of `{theme_id, name, description, includes, excludes}`; the last three fields are optional. Include/exclude arrays are supported. Do not add `other`; code adds it.
- `labels.json`: an object mapping at least 100 independently labeled summary IDs to frozen theme IDs or `other`. Select a representative sample before observing Jev outputs. Include no-match, ambiguous, multilingual, and neighboring-use-case examples.

```bash
PYTHONPATH=backend backend/.venv/bin/python -m logless.eval.classify_benchmark \
  --summaries /private/path/summaries.jsonl \
  --taxonomy /private/path/taxonomy.json \
  --labels /private/path/labels.json \
  --data-dir /private/path/new-benchmark-run \
  --env-file .env.local
```

The full command requires exactly 10,000 distinct summaries. It never duplicates a small corpus to reach that count. Genuine duplicate content needs a separately audited dataset and is rejected by this benchmark. `--pilot-only` permits a smaller integration check, which never qualifies the 10k target.

The command compares single-summary requests with batch caps 32 and 128 on the same labeled inputs, chooses the fastest passing pilot, and runs all 10,000 cold through that layout. Defaults require at least 90% labeled accuracy and no more than two percentage points below the single-request baseline. These are explicit initial acceptance thresholds, not proof of quality for every domain. `--min-accuracy`, `--max-accuracy-drop`, `--batch-sizes`, and `--concurrency` are configurable. Reusing the selection sample for evaluation is reported; it is not a new held-out test.

`comparison.json` and the private database retain results. The command exits nonzero on account failure, quality failure, or a missed full target. A library report's `latency_target_met` covers throughput only. The benchmark's `target_met` also requires its accuracy gate. Neither replaces an operator check that the workload and labels are representative.

At 250,000 input tokens/second, 10,000 assignments in 10 seconds permit at most 2.5 million effective input tokens, or 250 per summary, including shared definitions, repeated option lists, instructions, and retries. This is necessary, not sufficient: network, inference tail latency, request rate, conservative packing, and commit time also matter.

## Verified live smoke result — 2026-09-27

**20 authored integration cases, five use cases plus Other; not real prepared chat summaries and not representative accuracy.** Labels were written before the API calls. These were actual HTTP requests to `api.typesafe.ai`, not mocked responses. Model: `jev-1.13.0`. Local cache was bypassed.

| Layout | Requests | POST-to-validated-storage | Actual input tokens | Tokens/summary | Request bytes | Label matches | 429s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| One summary | 20 | 1.0735 s | 14,217 | 710.85 | 1,311–1,342 | 20/20 | 0 |
| Batch cap 8 | 3 | 0.2455 s | 4,107 | 205.35 | 2,544–4,158 | 20/20 | 0 |
| Batch cap 32 (actual 20) | 1 | 0.1530 s | 2,931 | 146.55 | 9,010 | 20/20 | 0 |

All 60 assignments committed and matched exactly across layouts. The fastest verified result is **20 cases in 0.1530 seconds**. It is not a 10,000-item result or an estimate of full-run wall time. The observed reduction comes from fewer requests and amortized taxonomy tokens. A real taxonomy with many more options may exceed the 250-token budget even with short summaries.

Local evidence: `var/jev-live-smoke-1/private.db` and `var/jev-live-smoke-1/comparison.json`. Inputs and prewritten labels: `var/jev-smoke-inputs/`. These are ignored local artifacts. The smoke predates the added feedback calibration; it used the more conservative initial token gate. No live 10k result is available.

## Summary preparation cost estimate

Vultr's [live model catalog](https://api.vultrinference.com/v1/models), checked 2026-09-27, publishes:

| Model | Input / million tokens | Output / million tokens |
| --- | ---: | ---: |
| `glm-5.3-flash` | $0.10 | $0.35 |
| `deepseek-v4.1-flash` | $0.15 | $0.60 |

For 10,000 summaries with 150 output tokens each, assuming uncached input and reasoning disabled:

| Mean total input tokens/request, including instructions | GLM | DeepSeek |
| --- | ---: | ---: |
| 1,000 | $1.53 | $2.40 |
| 2,000 | $2.53 | $3.90 |
| 5,000 | $5.53 | $8.40 |
| 10,000 | $10.53 | $15.90 |

These are estimates, excluding retries, privacy rewrites/checks, taxonomy creation, labels, and additional reasoning tokens. No summary-generation calls were made. The existing facet pipeline routes half its inputs to the more expensive full GLM-5.3 model and performs privacy checks, so its actual cost differs from a Flash-only preparation pass. Aim for concise goal/task summaries and measure total Jev input tokens; 150 summary tokens alone do not guarantee the complete 250-token classification budget.
