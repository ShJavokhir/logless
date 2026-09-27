# logless · web

Vite + React + TypeScript (strict) + Tailwind v4 + shadcn/ui. The browser only ever receives
aggregates from the API in `docs/CONTRACTS.md` §5–6; types live in `src/lib/types.ts`.

```bash
pnpm install
pnpm dev          # http://localhost:5173, /api proxied to http://127.0.0.1:8000
pnpm test         # vitest (pure logic + mock-snapshot invariants)
pnpm typecheck    # tsc -b (app + node configs; plain `tsc --noEmit` checks nothing here)
pnpm lint         # oxlint
pnpm build        # typecheck + production bundle in dist/
pnpm gen:mock     # regenerate src/mocks/snapshot.json from scripts/gen-snapshot.ts
```

## Mock vs live API

`VITE_MOCK=1` forces the in-browser mock, `VITE_MOCK=0` forces the real API. When unset,
`pnpm dev` uses the mock and `pnpm build` uses the real API (the mock is tree-shaken out).

```bash
VITE_MOCK=0 pnpm dev      # dev server against the FastAPI backend on :8000
VITE_MOCK=0 VITE_API_TARGET=https://144-202-110-2.sslip.io pnpm dev   # against a deployed API
VITE_MOCK=1 pnpm build    # demo bundle with the mock (loaded as a separate chunk)
```

Mock-only URL switches: `?sandbox=down` (health degraded, questions return
`sandbox_unreachable`), `?gate=fail` (program A still fails the gate after its repair),
`?budget=out` (live features return `429 budget_exhausted`) and `?snapshot=real`
(serve `src/mocks/real-snapshot.json`, a saved copy of the live snapshot:
`curl -s https://…/api/snapshot > src/mocks/real-snapshot.json`).

## Live features

- **Semantic map zoom**: the overview shows category names over faint workflow bubbles.
  Scroll or pinch to reveal workflow labels and counts without rearranging the bubbles;
  drag to pan, click/tap a category to frame it, or use the on-map zoom controls.
  With the map focused, `+` / `-` zoom, arrows pan, and `Escape` / `Home` / `0` reset.
  Labels fade with available screen space; reduced motion skips camera easing.
  Zoom uses the published aggregates and makes no model calls.
- **Map lens** (Usage | Friction): recolours the map from the published snapshot; no run.
- **Ask a question** (CONTRACTS §0/§8b) is the only live action. The answer card shows the
  interpreted plan in words, the agent loop (two independent programs, A pandas and B plain
  Python: shas, gVisor times, gate n/n, published-map cross-checks, agreement, repairs) and the
  verified rows. Run details shows both programs with every version, receipt and gate verdict.
- **Presenter capacity**: open the app once with `?presenter=<key>`; the key is moved to
  localStorage, stripped from the URL, and sent as `X-Logless-Presenter` on every API call.
- **Live intake** (CONTRACTS §11, presenter-only): with a presenter key stored and a batch ready,
  a "Live intake" control appears in the map header. The map crossfades into a routing diagram:
  incoming conversation tiles pass through Jev into the frozen categories, with a separate
  Other or unclear row. Each landed tile increments its row; orange marks observed friction.
  The panel shows stages, rates and a sampled feed of PII-checked one-line summaries. The flow
  retains its totals for 1.2 seconds after publication, then returns to the updated map and toast.
  Reduced motion files decisions without flights; resize and background catch-up preserve counts.
  Failed runs return immediately to the map. "Reset intake" re-publishes the base
  snapshot for rehearsals. In mock mode try `?snapshot=real&presenter=demo`.

## Layout

- `src/lib/` — `types.ts` (contract), `api.ts` (client + mock switch), `hierarchy.ts` (two-level
  circle packing), `search.ts`, `template.ts` (`{{metric}}` filling), `runs.ts`, `format.ts`, `colors.ts`
- `src/components/` — `UsageMap`, `ClusterList`, `DetailPanel`, `StoryPanel`, `AnswerCard`,
  `RunDetailsSheet` (incl. containment check), `EvalDialog`, `Chrome` (header/toolbar/footer)
- `src/mocks/` — WildChat-shaped snapshot, run state machines, stories, eval report
- `screenshots/` — reference captures at 1440×900 and 390×844
