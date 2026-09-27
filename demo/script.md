# logless: one-minute demo script (v2: live intake, two-program answers, rm -rf)

**Final cut:** `logless-demo.mp4`, 59.3 s, 1440×900, H.264 High + AAC, with captions burned in. `logless-demo-silent.mp4` is the same cut without audio.
**Recorded against:** https://144-202-110-2.sslip.io on Sep 26, 2026, about 22:05 PDT, as one live take plus a separate Evaluation clip.

- **Base snapshot:** `snap_20260927T040954_6a04`, with 5,050 conversations (5,000 WildChat + 50 test fixtures).
- **After the live intake:** `snap_20260927T050347_cf87`, with 5,350 conversations.

**Narration:** macOS `say`, voice Samantha (the only natural English voice installed), about 175 wpm. It has 129 caption words and 136 spoken words, because numbers are spelled out for the voice.

- **Read off the screen:** the {rate} and {targets} values are captured during the take.
- **Checked on screen during the take:** the header shows "5,000 WildChat". The intake decided 300/300. The key finding is under a fifth of conversations and over a quarter of the friction (18.0% / 28.7%). The programs agree. The rm -rf card shows the command absorbed, a read-only root and the container destroyed. The Evaluation shows 0 detected canary leaks.

| # | Time | On screen | Narration / caption |
|---|---|---|---|
| 1 | 0:00 | Title card. "logless reads them so nobody has to." fades in. | "Users tell you what's broken every day, but you can't read their conversations." |
| 2 | 0:05 | Map. The pointer rests on **Aggregate insights only**, whose tooltip says the map is computed by the logless pipeline on Vultr from 5,000 real conversations, and that no one can open a conversation. | "5,000 real conversations, read only by an LLM pipeline on Vultr." |
| 3 | 0:10 | **Live intake**. 300 dots fly from the inbox into the map in real time. The panel counts 300/300 at 126–128 conv/s, 170 ms p50, 5 decisions per conversation, with the one-line summary feed. Next come the privacy gate and publishing (**2× speed**). Then "Map updated · +300 conversations (70 to Other or unclear)" and the completion toast. | "300 new ones arrive, pre-read by GLM." / "Jev decides each live, about 130 a second." / "The privacy gate re-checks; the map republishes." |
| 4 | 0:21 | Key finding "Coding help is 18.0% of conversations but 28.7% of observed friction", then **Show where it breaks**, which zooms into Coding help and selects Data scripts (48.6% friction). | "Coding is under a fifth of conversations, but over a quarter of the friction." |
| 5 | 0:26 | **Ask a question**, then the chip "Which coding workflows have the most distinct people repeating requests?". The plan appears as "Distinct people · with repeated requests · within Coding help · by workflow · top 5 by count". The loop strip shows: wrote 2 programs (A pandas, B plain Python), ran both in gVisor, gate 34/34 plus map 2/2, programs agree (identical), explained. The waiting part runs at **4× speed**. The result is **Verified · 29.5 s**, with 5 verified rows. | "GLM plans the question and writes two independent programs without seeing any data." / "Each runs in its own gVisor sandbox; both must agree and pass the gate." |
| 6 | 0:37 | **Run details**: Program A (pandas) and Program B (plain Python) side by side, each gate 17/17, with code and receipt (runsc, no network). Then the cross-checks: consistent with the published map, and "Two independent programs agree". | "Every answer has a receipt: both programs and their cross-checks." |
| 7 | 0:42 | **Run containment check**. The runaway bar runs in real time until "Execution limit reached · 2,113 ms measured vs 2,000 ms deadline". Next, "Running a destructive command…" changes to "Destructive command absorbed · `$ rm -rf --no-preserve-root /` · exit 1 · 11,094 deletions refused · Read-only filesystem, nothing deleted · Container destroyed · Next run clean". Last, "Leak attempt rejected by the gate". The wait before the rm -rf result runs at **2× speed**. | "A runaway program is killed at two seconds." / "rm -rf / hits a read-only root: nothing deleted." / "A per-person export is rejected by the gate." |
| 8 | 0:53 | **Evaluation** dialog showing "11 of 12 targets met" and 0 detected canary leaks, then the closing card: GLM on Vultr Serverless Inference · Jev by TypeSafe · gVisor sandbox on Vultr, plus the URL. | "11 of 12 evaluation targets met; 0 canary leaks." |

## Edits: all real, all disclosed

- **Sped up** (each with an "N× speed" pill):
  - intake gate and publish wait, 6.1 s shown at 2×;
  - question wait from the chip click to Verified, 30.0 s shown at 4×; 2× does not fit in 60 s;
  - containment wait from 1.2 s after the kill to the rm -rf result, 1.9 s shown at 2×.
- **Real time:**
  - the intake dot flight, from the first decision to 1.6 s after the last;
  - the runaway bar through 1.2 s after the kill, including the measured ms;
  - the rm -rf result;
  - all pointer actions.
- **Cut from the containment beat:** 1.1 s of an interim card state. For that 1.1 s the app showed "Leak attempt was NOT rejected" above "The gate rejected it…" while the run was still finishing. The final run record says `leak_attempt_rejected: true`, and the final state ("Leak attempt rejected by the gate") is what the video shows, held on its first frame.
  - This is a real UI/backend glitch and should be fixed before the live demo; see the report.
  - The recorder retried the check because of it. The retry is not in the cut.
  - The cut points are documented in `cut-notes.json` (copied from `$WORK/rec/marks.override.json`, which the build reads).
- **Evaluation recorded separately:** the take ended at the containment retry, so the Evaluation beat is a separate recording made after the intake reset. It shows the base snapshot's report, 11 of 12. The post-intake snapshot's report was not captured. It is joined with a short white dip, and the base-snapshot map is visible for about 0.5 s.
- **Trimmed:** otherwise only still holds at the ends of beats.

## Re-record

```sh
cd demo && pnpm install
./build.sh --dry                  # free rehearsal (output goes to $WORK/dry_out, not demo/)
./build.sh --record               # one live take: 1 intake + 1 question + 1 containment check, then build
./build.sh --eval-clip            # (optional, free) record only the Evaluation beat and splice it in
./build.sh                        # re-cut / re-voice the last take, no live runs
node record.mjs "$WORK" --reset-only   # reset the live intake and confirm it
```

**Presenter key:** `record.mjs` reads `PRESENTER_KEY` from the repo-root `.env` and puts it in the page's localStorage, which is where the app stores it after `/?presenter=`. The key never goes into a URL, frame, log or file.

**Intake reset:** after every take, the recorder resets the intake and confirms it twice, 20 s apart. The check requires ready, base and current snapshot `snap_20260927T040954_6a04`, and 5,050 conversations.
