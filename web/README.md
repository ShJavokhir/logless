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
`sandbox_unreachable`), `?gate=fail` (analysis fails the egress gate twice),
`?budget=out` (live features return `429 budget_exhausted`) and `?snapshot=real`
(serve `src/mocks/real-snapshot.json`, a saved copy of the live snapshot:
`curl -s https://…/api/snapshot > src/mocks/real-snapshot.json`).

## Layout

- `src/lib/` — `types.ts` (contract), `api.ts` (client + mock switch), `hierarchy.ts` (two-level
  circle packing), `search.ts`, `template.ts` (`{{metric}}` filling), `runs.ts`, `format.ts`, `colors.ts`
- `src/components/` — `UsageMap`, `ClusterList`, `DetailPanel`, `StoryPanel`, `AnswerCard`,
  `RunDetailsSheet` (incl. containment check), `EvalDialog`, `Chrome` (header/toolbar/footer)
- `src/mocks/` — WildChat-shaped snapshot, run state machines, stories, eval report
- `screenshots/` — reference captures at 1440×900 and 390×844
