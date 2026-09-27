# Next steps

Status as of 2026-09-27, `master` at `313a96e` (same as `origin/master`). Written for coding agents picking up work on this repo. Read `README.md`, `docs/ARCHITECTURE.md` and `docs/CONTRACTS.md` first; this file only covers what is unfinished.

## Current health

All local checks pass on `master` plus the uncommitted Ultrasort lab work:

- `web/`: `tsc -b` clean, `oxlint` clean (3 fast-refresh warnings in `src/main.tsx`), vitest green.
- `backend/`: `pytest` 386 passed.

The last build eval (`backend/logless/eval/last_build_summary.md`, snapshot `snap_20260927T031906_f1e8`) meets 9 of 12 targets. The misses are listed under item 3.

## Uncommitted work in the tree

These are in the working tree and not committed. The owner reviews the diff before anything is committed, so don't commit them yourself.

- `web/src/lib/marbleScene.ts`, `web/src/lab/MarbleLab.tsx` (modified), `web/src/lib/ultrasort.ts`, `web/src/components/UltrasortButton.tsx` (new): the Ultrasort before/after in the marble lab, at `#/marble-lab?mode=ultrasort`.
- `docs/ULTRASORT_HANDOFF.md`: the prompt for item 1.
- `architecture-canvas/`, `submission-slides/`: hackathon submission material. Decide whether they belong in the repo (item 8).

## Prioritized work

### 1. Wire Ultrasort into the real intake machine

**Gap:** the GLM drip, the Ultrasort button and the race clock exist only in the lab against a synthetic stream. `web/src/components/MarbleMachine.tsx` still shows "Sort with Jev" and has no before/after.

**Approach:** follow `docs/ULTRASORT_HANDOFF.md` exactly. It adds a simulated drip while armed, swaps the button for `UltrasortButton`, and runs the clock from the press to the last real `IntakeEvent`. Leave `useIntake`, event paging and the backend alone.

**Open decision:** the clock currently stops when `landedEvents.length === total` (last marble landed). The alternative is to stop at the last event's `t_ms` (last decision). The landed time includes animation, so it overstates Jev's time slightly. Ask the owner before you change it.

**Verify:** `bun run typecheck` and `bun run lint` in `web/`; open `#/explore?presenter=dev` against the dev API; check the drip, the wave, the flood and the result line; check reduced motion (no drip movement, no wave); report measured seconds for the batch. The drip ring buffer wrap past `dripCapacity` and the button hover state are not yet checked by eye.

**Rules:** every GLM number says "est."; never fake or re-pace real events; add no dependencies; update the "Sort with Jev" wording in `demo/LIVE_DEMO.md`.

### 2. Make the live intake handle 5,000 conversations fast, and measure it

**Gap:** the demo story is "5,000 chat summaries sorted in seconds", but nothing has measured that end to end.

- `backend/logless/intake.py` defaults to `prepare(n=300)`. It accepts 1 to 5,000, but `prepare` runs GLM facets and the PII check per conversation, which is slow at 5,000.
- `run_batch` makes one Jev call per conversation (5 questions each) with `jev_concurrency = 24` workers and no cache. Throughput at 5,000 is unmeasured.
- The faster prepared-summary path, `logless.pipeline.fast_classify.classify_prepared` (see `docs/JEV_FAST_CLASSIFICATION.md`), is not connected to intake. It publishes nothing, its benchmark requires exactly 10,000 summaries (smaller runs need `--pilot-only`), and its 10k-in-10s target is unverified.
- Intake accepts WildChat only.

**Approach:**

1. Time the current path first. Run `prepare(n=5000)` and `run_batch` on the deployed stack, and record prepare seconds, decide seconds, `per_second` and `p50_ms` from `IntakeCounters`. Put the numbers in `docs/JEV_FAST_CLASSIFICATION.md`.
2. If decide time is too slow for a live demo, route intake's decide stage through `classify_prepared` behind a config switch, so the classifier is swappable in one place. Keep the gate, invariants, leak scans and atomic publish unchanged: bad output must still fail the run.
3. Make prepare a separate, cached step (prepare once, then run many times), so the demo press measures only the Jev decide stage. Say so in the UI copy so the number is honest.
4. Let the benchmark accept any `n`, or document `--pilot-only` clearly for 5,000.

**Verify:** a focused E2E test that runs intake on a small real batch and checks the published snapshot reconciles; then one measured 5,000 run on the deployed stack. Confirm `GET /intake/status` reports `batch_size: 5000`.

### 3. Close the eval gaps

**Gap:** three targets are not met in the last build summary, and the README disagrees with it in places.

- **Correction F1 is 0.74 against a 0.8 target** (P 1.00, R 0.59, support 22). The README quotes 0.78. Recall is the problem: Jev is too strict at the 0.65 cutoff. The ablation shows raw Jev at 0.87 and GLM-flash alone at 0.84, so the loss comes from post-processing or the cutoff, not the model. Look at the correction question wording and the per-signal threshold before changing the model. Re-run the eval and update the README with whatever the report says.
- **Containment demo: "not yet verified"** in the build eval, while the README shows it run live from the UI. The eval runs at build time, before anyone presses the button. Either have the eval run the containment battery itself, or have the eval report read the last containment run's result.
- **Live question answered in the sandbox: not verified** in the build eval, for the same reason. Same fix.
- **Complaint signal** has support 1, so its F1 is meaningless. Add reference labels for complaints if the signal stays in the product.

**Verify:** `uv run` the eval, and check that `last_build_summary.md` and `README.md` agree on every number.

### 4. Loggy: answer at the sub-theme level

**Gap:** Loggy answers stop at leaves (level 2). Sub-themes (k-means inside each leaf, `public.db` table `subthemes`, served by `GET /api/subthemes`) exist on the map but never appear in answers. Leaves under 30 conversations have no sub-themes.

**Frontend step (no backend change):** in `web/src/story/LoggyTab.tsx`, the `Answer` component (around line 683) renders `result.rows.slice(0, 5)`. For each leaf row, show that leaf's sub-themes from `GET /api/subthemes` as a secondary breakdown. Label it as base-build counts, because sub-theme counts are not computed by the verified sandbox programs. `SubthemesResponse` in `web/src/lib/types.ts` already has the shape.

**Verified step (backend change, needs owner approval):** to let the sandbox programs compute sub-theme numbers, add a conversation-to-sub-theme membership table in the private data given to the sandbox, add `group_by: "subtheme"` (with a required leaf scope) to the plan grammar in `backend/logless/sandbox/plan.py`, teach both programs (A pandas, B stdlib) in `backend/logless/sandbox/analysis.py`, and extend the egress gate in `backend/logless/sandbox/gate.py` so sub-theme ids are allowed and small groups are still suppressed. Update `docs/CONTRACTS.md` §8b and `Plan` in `types.ts` together.

**Verify:** ask Loggy a question whose top leaf has sub-themes; confirm the frontend breakdown shows, and (after the backend step) that programs A and B agree on sub-theme counts.

### 5. Merge or retire the open branches

- **`origin/codex/loggy-generative-ui`** (2 ahead, 1 behind): generative answer views using `json-render` and Jev (`backend/logless/api/canvas.py`, `web/src/components/AnswerCanvas.tsx`, `docs/GENERATIVE_UI.md`). It adds a dependency to `web/package.json`, so it needs the owner's sign-off. It also edits `LoggyTab.tsx`, so land it before or together with item 4 to avoid conflicts. A codex worktree for it lives at `/Users/ohong/.codex/worktrees/ee10/logless`.
- **`origin/oh-netbird-remote-control`** (5 ahead, 1 behind): phone remote control via a NetBird reverse proxy behind a PIN, a presenter QR dialog, and chat at `#/remote/<sid>`. It adds `lean-qr`. Rebase on `master`, run both test suites, and open a PR for review.
- **`origin/oh-mvp`** (4 ahead, 31 behind): stale. Check whether its 4 commits contain anything not on `master`, then ask the owner whether to delete it.

### 6. Throwaway instance per task (optional)

**Gap:** the README lists "Throwaway instance per task (optional)" as not done. Today each program gets a throwaway gVisor container on one long-lived sandbox VM.

**Approach:** only do this if the owner wants it. Keep the current runner interface and add a second runner that creates a Vultr instance per task and destroys it after. Select the runner by env var. Budget for boot time (tens of seconds), which will dominate live-question latency.

### 7. Demo and docs consistency

- `README.md` "Run it" uses `pnpm`, which matches `web/pnpm-lock.yaml`. Keep pnpm in this repo; don't mix package managers.
- After item 1, update `demo/LIVE_DEMO.md` and `demo/script.md` for the Ultrasort beat.
- After items 2 and 3, update every number in `README.md` from the eval report and the measured intake run. Never quote an unmeasured number without "est.".

### 8. Housekeeping

- Decide whether `architecture-canvas/` and `submission-slides/` are committed or moved out of the repo.
- `web/.captures/` is not gitignored. Add it to `.gitignore`, or keep captures in a temp directory.
- `var/public.db` snapshots in the repo can be empty (0 rows). Tools that read them should fail loudly on an empty snapshot instead of failing on a JSON decode.
- `fastapi.testclient` emits a Starlette deprecation warning about `httpx`. Low priority.

## Constraints that apply to all of the above

- Don't fake events or numbers in the real flow. Simulated visuals (the GLM drip) are allowed only when labelled as estimates.
- Don't add dependencies without the owner's approval.
- Don't change the backend, the event paging or the published contract without approval; when you do, update `docs/CONTRACTS.md` and `web/src/lib/types.ts` in the same change.
- Test with E2E tests against real behavior, not mocks.
