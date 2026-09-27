<!-- take-notes-session: "1433b859-e737-429a-a4c6-64e520cc847f" -->
# WildChat Flash summarization throughput

<!-- take-notes-payload-sha256: f2f1e8534cbc9ea9c14ed518af7d1f15bc97414ef4e338adb6e8c0bc57459a85 -->
Coverage: this note comes from the full current session (two questions about throughput, then this request).

## Context

We plan to do the pre-processing (the per-conversation summaries, or "facets") later with `glm-5.3-flash` on Vultr Serverless Inference. The target is 100,000 WildChat-1M conversations.

## Throughput estimate at current settings

- The facet step is `extract_one` in `backend/logless/pipeline/facets.py`: a Flash summary (goal, task, domain, language), then a Jev PII check, then a Flash rewrite if the PII check flags the summary.
- A code comment in `facets.py` (near `primary_model`) says Vultr's per-model rate limit caps Flash at about 2.5 conversations/s. The code comment is the only source. We did not measure it again. The local `var/private.db` is empty; the real 5,050-conversation build ran on the app VM.
- At 2.5/s, 100k conversations take about 11 h on Flash alone. With the current 50/50 overflow to `glm-5.3` (`OVERFLOW_PCT = 50`), they take about 5.5 h, if `glm-5.3` has a similar cap.
- More workers do not help past about 16 (`glm_concurrency`). The rate limit is the bottleneck, not call latency.
- We do not know if the limit counts requests or tokens, or if it is per model or per key.

## Cost estimate

- The 5,050-conversation build used about 25.6M estimated Jev input tokens, so the mean is about 5k tokens per conversation.
- Flash only: 100k × about 5.2k input tokens × $0.10/M ≈ $52, plus about $4 output. Total about $56.
- 50/50 with `glm-5.3` ($0.75/$3.00 per M): about $230.

## Ways to go faster

1. **Pack conversations.** Send about 10 conversations per request and ask for a JSON array of summaries. If the limit counts requests, this gives about 25 conversations/s on Flash, so about 1.1 h for 100k. Validate each item on its own and retry only missing or invalid items. `docs/JEV_FAST_CLASSIFICATION.md` shows that packing kept Jev labels correct.
2. **Add model lanes.** The Vultr limit is per model. Cheap models in the catalog (about $0.10/M input): `glm-5.3-flash`, `deepseek-v4-flash-0731`, `laguna-s-2.1`, `mimo-v2.6-flash-rl`, `nemotron-3-nano-omni-30b-a3b-reasoning`. Five lanes give about 12/s. Risk: each model has its own summary style, so clusters can split by model. Keep hash routing, record the model per row, and spot-check each lane first.
3. **Trim inputs.** Keep the first user turns and the last exchange, capped at about 1.5k tokens. If the limit counts tokens, this gives about 3× throughput and about 3× lower cost.
4. **Summarize a sample.** Summarize about 20k conversations to build the taxonomy. Classify the other 80k directly with Jev (24-way concurrency).
5. More API keys help only if the limit is per key. Check Vultr's terms first. Use this option last.

## Suggested run plan

1. Probe about 200 Flash calls: compare 1 vs 10 conversations per request and full vs trimmed text. Find where 429s start. This shows if the limit counts requests or tokens. Cost is under $1.
2. Add packing, trimming, and a per-model lane pool to `extract_one`. Each lane has its own concurrency, and lanes run in parallel.
3. Run a 2k-conversation pilot and compare quality across lanes. Then run the full set. The run resumes, because finished rows are skipped.

Expected result: about 30–60 min wall time and about $20–60 if packing works. If the limit counts tokens, expect about 1.5–2 h.
