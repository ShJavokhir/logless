# logless frontend prototype

## Status and run

The frontend is ready for a local, three-minute **mock-data demonstration** on branch `oh-mvp`. It runs without backend services or API keys. This does not establish completion of the full-stack hackathon requirements.

```sh
cd /Users/ohong/dev/logless
npm install
npm run dev -- --port 3000
```

Open <http://127.0.0.1:3000>. The development server binds to loopback only. Production frontend checks are `npm run check` and `npm run build`; `npm start -- --port 3000` serves the resulting build locally. Use a separate port if development is still running.

No existing frontend was present. This change adds one Next.js App Router application using TypeScript, React, CSS, d3-hierarchy, and Lucide icons. There are no API routes, mock servers, provider integrations, database changes, or deployment changes.

## Three-minute walkthrough

1. **0:00–0:25 — Establish the evidence.** Open the populated Usage view. Point to `Demo · Mock data`, the fixed observation period, and 600 conversations. Explain that these are authored aggregate fixtures.
2. **0:25–0:55 — Explore.** Use the category navigation or a circle. Circle area encodes conversation count. Outer circles group workflows; proximity carries no meaning.
3. **0:55–1:20 — Find.** Search `coordinating with other people`. Three workflows remain highlighted. The original counts and circle positions stay unchanged.
4. **1:20–1:55 — Understand friction.** Select Friction. Brief simulated analysis states resolve to the ranking. Open `Coordinating changing plans`: 108 of 600 conversations; observed friction in 46 of 108, or 42.6%.
5. **1:55–2:25 — Inspect supporting signals.** Open Supporting signals. Corrections: 31/108; complaints: 24/108; unresolved action errors: 14/108. These overlap. Fourteen other conversations have unclear assessments and no observed signal. Missing negative feedback does not establish success.
6. **2:25–2:50 — Make the need tangible.** Generate a user story. The panel displays Alex’s authored example, its fictional disclosure, and evidence-reference count.
7. **2:50–3:00 — Close.** Explain the product need: preserve a shared decision across changes and follow-ups. State that analysis and generation are simulated in this frontend.

Clear search with the X or Escape. Press `/` to focus search. Tab to a circle or navigation item and press Enter or Space. Escape closes the detail panel and returns focus. The complete navigation is available through the menu on phones.

## Data boundary and adapter handoff

```text
React explorer / detail panel
             |
             v
      DemoAdapter interface
             |
             v
  explicit local mock adapter
             |
             v
 authored aggregate fixtures
```

Components import types and the adapter through `src/frontend/data/index.ts`. Only the adapter imports fixtures; components do not access them. Mock mode is explicit and permanent in this build. It is not a fallback for live request failures.

No shared backend schemas existed at implementation time. Types in `src/frontend/data/types.ts` are **frontend-local, provisional representations** of the supplied specification’s published contracts. They do not redefine the backend contract. Agree on wire schemas with the backend owner before integration.

| Frontend adapter method | Intended published endpoint | Behavior in this prototype |
| --- | --- | --- |
| `getSnapshot({signal})` | `GET /api/snapshot` | Complete authored snapshot, including hierarchy, totals, period, provenance, and safe aggregate evidence |
| `search({snapshotId, query, signal})` | `POST /api/search` | Deterministic term matching; returns cluster/category IDs and measured local elapsed time |
| `createAnalysis({snapshotId, intent})` | `POST /api/analyses` | Only `usage` and `friction`; returns run ID and deduplicates equivalent active jobs |
| `getRun(runId, {signal})` | `GET /api/runs/{id}` | Simulated stages, terminal result/error, and explicitly simulated analysis receipt |
| `requestStory({snapshotId, clusterId})` | `POST /api/clusters/{id}/story` | Returns a cached story or a run ID; stories never report sandbox execution |

Integration requirements:

- Implement a separate HTTP adapter behind the same component boundary. Choose the transport explicitly. Never switch to mock data after a failed live call.
- Validate public payloads at the network boundary. Check snapshot identity, allowed IDs, exact counts, ratios, signal overlap, hierarchy, and safe evidence references.
- Ratios are fractions in `[0, 1]`; unavailable ratios are `null`. Display percentages to one decimal place. Usage divides by all snapshot conversations; friction divides by the selected workflow’s conversations.
- Render real execution states and receipts only when the backend supplies verified output. Mock receipts have `simulated: true`, `programHash: null`, and `sandboxId: null`.
- Replace the persistent mock disclosure only when a deliberate live mode exists. Synthetic-data and fictional-story disclosures still apply.
- Preserve abort signals and request identity guards. Superseded search, analysis, and story results must not replace current state.
- Clear caches on snapshot changes. The demo adapter instance isolates story caching to one snapshot. The live implementation needs explicit cache keys and publication-change handling.
- Default mock timing: snapshot 400 ms, search 220 ms after a 300 ms UI debounce, analysis about 1.7 s, story about 1.3 s. These are authored delays, not performance claims.
- Search is keyword/phrase matching, not semantic inference. This prototype contains no source conversations, user identities, private facets, or generated corpus.
- The map uses a common square-root radius scale and d3 sibling packing. Search and mode changes cannot affect layout. The current authored fixture has four categories. Recheck packing and long labels against the backend’s actual published hierarchy before integration.

## Development-only state checks

These query parameters are read only when `NODE_ENV=development`. They add no product settings or server behavior. Each configured failure happens once per loaded adapter; retry succeeds. Reloading resets the fixture.

| URL suffix | Exercise |
| --- | --- |
| `?demoFailure=snapshot` | Initial snapshot failure and Retry snapshot |
| `?demoFailure=search` | First search fails; Retry search preserves browsing |
| `?demoFailure=analysis` | First analysis fails; Retry analysis retains the published finding |
| `?demoFailure=story` | First story run fails; Retry user story retains the selected insight |
| `?demoState=empty` | Empty snapshot, followed by Load demo snapshot |

An unrelated query such as `quantum zebra submarines` exercises no matches. Quickly replace one query with another, switch analysis modes, or select a new cluster during story generation to exercise stale-response protection.

## Verification evidence

Executed against the local frontend:

- `npm run check`: strict TypeScript check and ten focused adapter tests passed.
- `npm run build`: production compilation and static page generation passed.
- Browser walkthrough at 1440 × 900: Usage → search → Friction → inspect → signals → story.
- Search: three coordination matches, no matches, clear, and superseded queries.
- Map geometry: all 12 positions/radii remained identical across search and mode changes. The 108-conversation circle had six times the area of the 18-conversation circle.
- All four one-shot failure/retry paths and empty-to-populated recovery passed in the browser.
- Switching clusters during story generation displayed only the new cluster’s story. Switching modes during analysis displayed the newest mode’s result.
- Returning to a generated story displayed `Previously generated`.
- Keyboard: `/` focused search; Escape cleared it; Enter opened a circle; Escape closed details and returned focus to that circle.
- Story completion announces the result and returns action focus to the story heading. Escape then closes the panel and restores the original control.
- Final chart-value contrast was measured at 5.06:1 on the darkest mock friction circle after review identified and fixed a contrast issue.
- 900 × 900 and 390 × 844: no horizontal overflow; stacked detail access worked. Phone navigation and story generation worked.
- Supporting signals displayed correct denominators, overlapping-signal guidance, and uncertainty. Browser console inspection returned no warnings or errors.
- Reduced-motion CSS disables transitions and spinner animation. A system-level reduced-motion toggle was not exercised.

Screenshots are in `frontend-evidence/screenshots/`. Files `01`–`07` record the main desktop flow; `08`–`13` record no-match and recovery states; `14`–`17` record narrow and phone layouts. The Ando reference contact sheet is in `frontend-evidence/reference/` and is study material only.

`frontend-evidence/browser-verification.json` records the observed browser checks. The core screenshots `01`–`07` were refreshed after the final accessibility fixes. State-test screenshots retain their tested state; some precede the chart-value contrast refinement.

The final walkthrough is `teaser-video/logless-walkthrough/renders/complete-30s.mp4`. It is exactly 30.000 seconds at 1920 × 1080, 30 fps, with H.264 video and AAC audio. Full decoding and the isolated video project's TypeScript check passed. The final seven source captures match the frontend screenshots byte for byte. The editable project, poster, storyboard, and sampled-frame review are preserved in that folder. Its `review.md` records the visual review and the remaining limit: audio received technical checks, but no listening pass.

## Files and shared configuration

| Ownership | Files |
| --- | --- |
| App entry, metadata, styling | `src/app/page.tsx`, `layout.tsx`, `globals.css`, `icon.svg` |
| Frontend UI and local state | `src/frontend/explorer.tsx`, `detail-panel.tsx`, `usage-map.tsx`, `format.ts` |
| Frontend-only data and tests | `src/frontend/data/{types,fixtures,adapter,index,adapter.test}.ts` |
| Frontend setup | `package.json`, `package-lock.json`, `tsconfig.json`, `next-env.d.ts`, `next.config.ts` |
| Evidence and delivery | `FRONTEND-HANDOFF.md`, `frontend-evidence/`, `teaser-video/logless-walkthrough/` |

The only existing shared file changed by this frontend work is `.gitignore`, which now ignores frontend dependency/build directories and TypeScript build metadata. Next.js generated `AGENTS.md` and `CLAUDE.md` during development. `next.config.ts` hides the development indicator; the app has no deployment configuration.

Concurrent changes appeared in `README.md`, `docs/`, `.agents/`, and `skills-lock.json`. They were preserved. A concurrent `.env.local` was detected by Next.js; this frontend does not read or require its credentials. No founding document was edited for this assignment. No commit, push, deployment, or external publication was performed.

## What remains for the complete project

The local frontend demo is usable now. The following work belongs to the backend/integration team before claiming the full specification or a live hackathon demo is complete:

1. Agree on and validate the final public schemas. Connect the HTTP adapter and verify all live loading/error states without mock fallback.
2. Build the synthetic source fixture and reproducible generation recipe. Keep generator expectations separate from discovery inputs.
3. Implement actual extraction, discovery, classification, and generalization using the specified providers. Record private provenance and enforce publication checks.
4. Compute and independently reconcile real aggregate results. Publish snapshots atomically and preserve the last good one after failures.
5. Implement real bounded analysis jobs, validated result artifacts, execution receipts, one correction attempt, and safe public run polling.
6. Implement grounded story generation, evidence validation, limited repair, and snapshot-scoped persistence. Review the real output against the same fictional-story boundary.
7. Implement and verify disposable sandbox controls and the real containment fixture. This prototype has no containment control and makes no claim of sandbox execution.
8. Run publication-boundary, no-answer-leakage, provider, arithmetic, sandbox, recovery, and deployed performance checks from the founding specification.
9. Deploy on the required platform and verify the public HTTPS boundary. No public deployment has been created or tested here.
10. Rehearse a real three-minute run and create any required one-minute submission recording using genuine execution and containment evidence. This 30-second mock walkthrough does not satisfy those live-system requirements.
11. Decide production access, retention, privacy, and security requirements before using any real customer data. The synthetic-only prototype is not a validated privacy system.

No additional user information is needed to run or present the local frontend prototype.
