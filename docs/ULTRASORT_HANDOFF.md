# Ultrasort handoff: wire the before/after into the real intake

Paste the prompt below into Claude Code (Opus 5.5) at the repo root. It assumes the lab work is on your branch: `web/src/lib/marbleScene.ts`, `web/src/lib/ultrasort.ts`, `web/src/components/UltrasortButton.tsx`, `web/src/lab/MarbleLab.tsx`.

---

Wire the Ultrasort before/after from the marble lab into the real intake machine, with the smallest change that works.

**Reference implementation:** `UltrasortLab` in `web/src/lab/MarbleLab.tsx` (open `#/marble-lab?mode=ultrasort`). It already does the full sequence against a synthetic stream: a GLM drip while armed, then Space or the button calls `scene.ultrasort()`, then the flood, a race clock, and `resultLine()`. Copy its drip loop and its clock. Don't copy `pushStream`, because that is the fake stream.

**Target:** `web/src/components/MarbleMachine.tsx`. Its frame loop already pushes real `IntakeEvent`s from `useIntake` into `scene.push(bin, friction)`. Leave that path as it is. Add only these pieces:

1. **Drip while armed.** Pass `dripCapacity: 3000, dripHold: GLM_BASELINE.secondsPerCall` to `createMarbleScene`. In the existing rAF loop, while `armed`, call `scene.drip(bin)` at `glmRate()` per second, paced by elapsed time as the lab does, with `bin` sampled by `bins.spec[i].weight`. Drips are simulated and the scene never counts them.
2. **Ultrasort press.** Replace the "Sort with Jev" button with `<UltrasortButton onPress={sort} pressed={!armed} reducedMotion={intake.visual.reducedMotion} />`, where `sort` calls `sceneRef.current?.ultrasort()` and then `onSort()`. The existing Space/Enter handler calls the same `sort`.
3. **Race clock and result line.** Record `performance.now()` at the press. Stop the clock when `intake.landedEvents.length === total`. Then show `resultLine(total, seconds)` from `web/src/lib/ultrasort.ts`. While armed, show `glmPaceLabel()` and `glmEtaLabel(total)`.

**Rules:**

- Every GLM number is an estimate and must say "est.". Jev's time comes only from measured timestamps of real events.
- Don't fake, pad, or re-pace events. If the backend streams slowly, the clock shows that.
- Don't change the backend, `useIntake`, or event paging.
- Add no dependencies, and don't commit.
- The batch is 5,000 prepared chat summaries. `total` already comes from `counters.total ?? status.batch_size`, so the scene capacity follows the backend. Confirm that `GET /intake/status` reports `batch_size: 5000`.
- Update the "Sort with Jev" wording in `demo/LIVE_DEMO.md` to "Ultrasort".

**Verify:**

- Run `bun run typecheck` and `bun run lint` in `web/`.
- Open `#/explore?presenter=dev` with the dev API and check that the drip runs while armed.
- Press Space. The violet wave and camera pull-back should play, and the real marbles should flood the bins.
- Check that the clock stops at the last real event and the result line shows.
- Check reduced motion: the drip should be absent or static, and no wave should play.
- Report the measured seconds for 5,000 events.
