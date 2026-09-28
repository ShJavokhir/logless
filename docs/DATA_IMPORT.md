# Import another conversation dataset

The pinned WildChat sample is the default demo source. The `import` command also accepts a
bounded JSONL export of **text assistant conversations**. It does not ingest arbitrary tables,
documents, images, audio, or provider-specific export formats automatically.

Create a new private data directory for each source. Import refuses a nonempty destination and
never replaces the demo corpus. The importer is local and makes no model calls; `rebuild` uses
the configured Vultr, TypeSafe, and Fireworks providers and incurs their normal usage.

```bash
# Run from the repository root. Keep source exports outside the destination directory.
export PSEUDONYM_SALT='<a fresh, randomly generated private secret>'
backend/.venv/bin/logless import /absolute/path/conversations.jsonl \
  --metadata /absolute/path/source.json --data-dir /absolute/path/new-private-data

# Use this same directory and salt for subsequent commands.
export LOGLESS_DATA_DIR=/absolute/path/new-private-data
backend/.venv/bin/logless rebuild
backend/.venv/bin/logless eval
backend/.venv/bin/logless serve
```

Do not run the WildChat `seed` or `intake prepare` commands against an imported workspace.
Those adapters reject mixed-source workspaces. There is no browser upload endpoint.

## Private conversation schema

One UTF-8 JSON object per line; blank lines are ignored. Each conversation requires a unique
string `id`, a stable string `user_id`, and `messages`. Equal source user IDs become equal HMAC
pseudonyms; different IDs are counted separately. Account IDs are a proxy for people, and shared
accounts or rotating IDs affect that interpretation.
Identifiers are preserved exactly after rejecting blank values: case, surrounding whitespace,
and Unicode normalization differences are not silently merged. Clean those differences upstream
only when the source system says they identify the same account/conversation.

```json
{"id":"ticket-one","user_id":"account-one","language":"English","timestamp":"2026-09-26T16:30:00Z","model":"support-assistant","messages":[{"role":"user","content":"How can I return a product?"},{"role":"assistant","content":"Start with the return form."}]}
```

- Optional fields: `language` (default `Unknown`), `timestamp`, and `model`.
- Language metadata is published only through the closed
  [canonical vocabulary](../backend/logless/data/languages.py): 105 supported ISO 639-1 codes,
  their English names, and regional/script tags such as `en-US`, `pt_BR`, or `zh-Hant-TW`.
  Unrecognized strings become `Unknown`; free-form labels are never copied into public language
  breakdowns. Missing/unrecognized labels do not restrict analysis of the conversation text.
  `dataset.languages` counts known language labels only; `Unknown` conversations still appear
  in the aggregate breakdown or its `Other languages` remainder.
- Timestamps must be ISO 8601 with a time zone; they are normalized to UTC.
- Messages have exactly `role` and string `content`. Supported roles: `user`, `assistant`,
  `system`, `developer`, and `tool`. At least one nonempty user message is required.
- Rejects unknown fields, duplicate conversation IDs, duplicate JSON keys, nonfinite JSON
  numbers, malformed UTF-8, escaped lone Unicode surrogates, empty datasets, and non-text
  message content before opening the database. Valid escaped surrogate pairs (for example emoji)
  are accepted. The same Unicode validation applies to every public metadata string and JSON key.
- Limits: 100 MiB per source file, 50,000 conversations, 1 MiB per line, 1,000 messages per
  conversation, 512 characters per source ID/user ID, 60 for language, and 120 for model.
- The existing context caps apply: long messages are shortened to head/tail excerpts at a
  3,000-character threshold and long conversations at 16,000 characters. Published metadata
  discloses how many conversations were truncated. This can remove evidence in long conversations.
- Raw text stays in the private SQLite database and is sent to the configured Vultr and TypeSafe
  providers during analysis. Fireworks receives generalized facet text. This is not an on-device
  or zero-retention promise; provider handling must match the operator's data agreements.

## Public metadata schema

The separate `source.json` is an explicit publication boundary. Every listed field is intended
to appear in the browser; do not put private names, credentials, private source URLs, or customer
identifiers here. The importer checks bounded strings and common contact/identifier patterns,
but the operator remains responsible for the source attribution and rights statement.

```json
{
  "name": "Support pilot",
  "workspace_name": "Support assistant",
  "workspace_description": "An evaluation of support conversations.",
  "source_url": "",
  "revision": "pilot-v1",
  "license": "Organization-owned data",
  "attribution": "Provided by the workspace operator",
  "people_note": "People are distinct account IDs; shared accounts may represent several people.",
  "intended_uses": ["Answer product support questions", "Explain return procedures"]
}
```

All fields except `source_url` are required. `source_url` may be empty; otherwise it must be HTTPS
without embedded credentials, query parameters, or a fragment. Limits: name 60 characters,
workspace name 120, workspace description 600, URL 200, revision 64, license 40, attribution 400,
people note 200, and 1–20 intended uses of up to 120 characters each. Unknown fields are rejected.
The private provenance record also stores the SHA-256 of the exact input bytes and adapter version.

## What is verified

The automated import test runs all eleven pipeline stages with deterministic **mock providers**
on a small multilingual corpus with duplicate-only embeddings. It checks real SQLite storage,
stable pseudonyms, counts, adaptive discovery, metadata, atomic publication, and the API serializer.
Separate tests verify malformed provider responses and snapshot evaluation after mutable labels
change. This establishes mechanics; it does not establish model quality on a new domain.

The taxonomy permits 1–8 categories and 1–35 leaves, including the catch-all; small corpora are not
forced into a demo-sized map. The single-centroid case is supported. A useful taxonomy is still a
model quality question, and the system is not claimed to work well on every conversation dataset.

New sources have no WildChat reference labels or planted canaries by default. Evaluation therefore
shows those checks as unverified rather than inheriting a success from the demo. To measure quality,
create a held-out, source-appropriate reference set, review stratified samples (languages, domains,
conversation lengths and rare workflows), and measure precision/recall with adequate positive
support. Do not tune and report final performance on the same examples.

## Synthetic reconstruction check

A synthetic corpus with a known mix measures model quality without hand labels, in the way Clio
does. `synth` asks GLM to write conversations from the topic, language and correction mix in
`backend/logless/eval/synthetic_mix.json` (including two rare topics at 2–3%). It writes an
importable `conversations.jsonl` and `source.json`, and keeps the true labels in `truth.jsonl`,
which the pipeline never reads. `reconstruct` then scores the published build against the truth.

```bash
backend/.venv/bin/logless synth --n 5000 --out /absolute/path/synth
backend/.venv/bin/logless import /absolute/path/synth/conversations.jsonl \
  --metadata /absolute/path/synth/source.json --data-dir /absolute/path/synth-data
export LOGLESS_DATA_DIR=/absolute/path/synth-data
backend/.venv/bin/logless rebuild
backend/.venv/bin/logless reconstruct /absolute/path/synth/truth.jsonl
```

The report (also saved to `artifacts/eval/reconstruct.json`) gives the adjusted Rand index between
true topic and leaf, the total variation distance between the true topic mix and the mix the leaves
imply (each leaf counts as its majority topic, and Other counts as unassigned), and precision and
recall of the `correction` signal against planted corrections. It repeats these per true language
and per facet model lane, and omits scores for groups under 30 conversations. `synth` fails if more
than 5% of generations fail, because silently dropped chats would bias the mix. Both commands need
the provider keys, so run them on the VM.
