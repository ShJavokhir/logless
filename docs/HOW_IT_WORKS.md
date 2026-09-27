# Interactive explainer

The web app exposes `/#/how-it-works`, linked from the product tour and workspace.
It runs independently of the API so readers can understand Logless before opening
the live demo. Its personal-assistant examples and output-gate cases are authored
illustrations, not measured findings or sandbox executions.

The source-data section shows shortened excerpts from three public `allenai/WildChat`
rows: travel advice (133), Rust programming (160), and an Arabic research exchange
(4). Each card links to its full dataset row. Editorial summaries are labeled and
kept separate from quoted source text. These rows are not claimed to be in the
Logless demo sample.

## What it explains

- The product question: what users do and where they encounter friction.
- Private conversations → generalized facets → themes → Jev decisions → published insights.
- The current embeddings, privacy checks and trusted-code aggregation path.
- Live questions: plan → two programs → isolated execution → output checks → explanation.
- What reaches the browser, model providers and sandbox, with the documented limits.

Source of truth: `README.md`, `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.
The expandable infographic is conceptual; the prose describes the current pipeline.

## Interaction and motion

Desktop and mobile use an explicit five-step selector, showing one explanation
and example at a time. The presentation layout uses larger, higher-contrast type,
short main copy, and expandable technical details.
Readers can change scenarios, select map nodes, inspect implementation notes,
and compare allowed, blocked and disagreeing output cases.

Lenis 1.3.26 runs only while this route is mounted. It leaves touch scrolling native,
supports an opt-out, and is disabled for system reduced motion. Keyboard chapter
navigation is immediate. Lenis reads the target's CSS scroll margin for header
clearance. The instance is destroyed on exit. The page and its styles are lazy loaded.

## Local verification

Run `cd web && pnpm test && pnpm build` and open `/#/how-it-works` in the dev server.
Check the example selector, all pipeline steps, map keyboard selection, all three
output scenarios, the infographic disclosure, FAQs, the smooth-scroll toggle,
and navigation back to the product. Narrow layouts must not overflow horizontally.
