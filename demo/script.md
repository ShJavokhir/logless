# logless: one-minute demo script

**Target:** ≤ 60 s, 1440×900, H.264 + AAC. Vultr Agent Arena, Track 1: Agent Sandboxing.
**Final cut:** `logless-demo.mp4`, 59.2 s (`logless-demo-silent.mp4` is the same cut with captions only).
**Recorded against:** https://144-202-110-2.sslip.io, snapshot `snap_20260927T015930_bf1a`, one continuous live take (Sep 26, 2026, 19:38 PDT).

Narration: macOS `say`, voice Samantha (the only natural English voice installed; no Premium or Enhanced voices on this Mac), about 175 wpm, 128 caption words. Captions are burned in under the map panel so the video also works muted.

| # | Time | On screen | Narration / caption |
|---|------|-----------|---------------------|
| 1 | 0:00 | Title card. The second line fades in when the voice reaches it. | "Users tell you what's broken every day — but you can't read their conversations." / "logless reads them so nobody has to." |
| 2 | 0:07 | Usage map (34 workflows, 7 categories). The pointer hovers "Concept explanations", then "Probing the AI" (tooltip: 207 conversations, 185 people). | "5,000 real WildChat conversations, grouped by agents into 34 workflows." / "One of them is people testing the AI itself." |
| 3 | 0:15 | Click **What's not working?**. A live run steps through writing the program, the gVisor run, the gate and the explanation (**2× speed** while waiting), then shows **Verified · 7.4 s** and gate 16/16. The map switches to the friction lens, and the pointer rests on "Fixing errors" (39.5%). | "GLM on Vultr writes a program without seeing any data." / "It runs in a gVisor sandbox with no network, and a gate checks every number." / "Software work has the highest friction rate." |
| 4 | 0:27 | Open "Fixing errors" (friction 39.5%, signals), scroll down, click **Generate fictional user story**. The story card appears, labelled fiction, with evidence-id chips. | "In "Fixing errors", 39.5% of conversations show friction." / "A clearly labelled fictional story makes the pattern concrete." |
| 5 | 0:36 | **Run details** sheet shows the execution receipt (runsc (gVisor), network none, read-only root, container removed) and the egress gate at 16/16. Then **Run containment check**: the runaway bar runs in real time, and the result reads **2,124 ms measured vs 2,000 ms deadline**, container removed, app health ok, follow-up run passed. Next, "Leak attempt rejected by the gate" (the per-person export fails the allowlisted-fields and exact-schema checks). The wait between the kill and the leak result runs at **2× speed**. | "Every run leaves a receipt." / "Now the containment check." / "A runaway program is killed at its 2-second deadline." / "A program that tries to export per-person rows is rejected by the gate." |
| 6 | 0:50 | Footer **Evaluation** dialog shows 14 of 15 targets met, 0 detected canary leaks. The closing card at 0:56 reads "GLM on Vultr Serverless Inference · Jev by TypeSafe · Embeddings by Fireworks · gVisor sandbox on Vultr" plus the live URL. | "14 of 15 evaluation targets met, with 0 detected canary leaks." |

The eval count is not hard-coded. `record.mjs` reads "N of M targets met" from the dialog during the take, and `voice.mjs` fills `{targets}` in `beats.json` from it. The count moves as the live checks update: it was 13 of 14 in the brief, then 13 of 15, and 14 of 15 at the final take. The take also confirms the other spoken numbers on screen (207 / 185, 34 workflows, 39.5%, 0 detected canary leaks) and writes them to `rec/facts.json`.

## What is sped up

Only waiting stretches are sped up, and each carries a "2× speed" pill:

- The analysis run from click to Verified: 8.6 s shown at 2×.
- The containment check from 1.6 s after the kill to the leak result: 4.6 s shown at 2×.

Everything else plays in real time. That includes the runaway program from start to the kill, the measured milliseconds, and the 1.6 s after the kill. The story was already generated for this workflow (earlier take), so it appeared at once and needed no speed-up. The only other edits are trimmed idle holds at the ends of beats, where the pointer is still.

## Files

- `beats.json`: narration and captions per beat, plus the recording mark each line is anchored to.
- `voice.mjs`: runs `say` once per line, trims the silence, and writes `voice.json`.
- `record.mjs`: runs Playwright against the live app. It captures with a CDP screencast (JPEG q92, at device scale factor 4/3, downsampled to 1440×900) and draws an injected pointer overlay. Its waits are keyed to UI states: the Verified chip, `#story-card-h`, "Execution limit reached", "Leak attempt rejected". It aborts on a failed or paused step or a failed preflight (mock API, sandbox unreachable).
- `render.mjs`: renders the title and closing cards, the caption PNGs and the speed pills (Geist, the app's palette).
- `timeline.mjs`: makes frame-exact cuts and speed-ups, places narration on anchors, trims holds to fit the narration, and caps the total at 59.6 s.
- `build.sh`: runs the whole pipeline and the ffmpeg assembly, then extracts the stills.

## Re-record

```sh
cd demo
pnpm install                      # playwright 1.57.0 (uses the cached chromium-1200); or set PLAYWRIGHT=/path/to/playwright/index.mjs
./build.sh --dry                  # free rehearsal: map + evaluation only
./build.sh --record               # one live take (1 analysis + 1 story + 1 containment run), then build
./build.sh                        # re-cut / re-voice / re-encode the last take, no new runs
```

`WORK` (default `demo/.work`) holds the frames and intermediates. Edit `beats.json` to change the wording. Holds in the recording are generous, so wording changes usually need only `./build.sh`.
