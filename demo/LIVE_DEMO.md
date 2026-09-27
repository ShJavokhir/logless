# Three-minute manual demo

**URL:** https://144-202-110-2.sslip.io

**Lead with the work:** “Which assistant workflows need a product team's attention? Logless groups conversations, then an agent writes and executes checked analysis programs without exposing transcripts to the analyst.” The map is context; the live question and its execution evidence are the centerpiece for Agent Sandboxing Track 1.

The prerecorded video shows the September 26 build. Its evaluation clip comes from the base snapshot, not the post-intake snapshot used by the live question, and its intake feed shows the older per-conversation summaries. The recorder resets intake automatically; it is not a read-only rehearsal tool.

## Before the demo

1. Use a fresh browser session, at least 1440×900, 100% zoom. Confirm the footer says live, not mock. Read the **current** dataset and fixture counts; intake changes them.
2. `/api/health` must report `status: ok`, `sandbox: reachable`, and the same snapshot ID as `/api/snapshot`. Health alone does not prove a question will pass.
3. Open the presenter link once, using the local secret without displaying it: `https://144-202-110-2.sslip.io/?presenter=<PRESENTER_KEY>`. The app removes it from the URL and uses a reserved budget. Never put the key in a slide, recording, command history or public doc.
4. Rehearse one question and containment on the **deployed version**. Read the interpreted plan and both final receipts. Measure wall time, including repair. Historical successful runs include repairs; do not promise first-attempt success or fixed latency.
5. Keep the snapshot stable during the question. Do not run a rebuild, intake or reset concurrently. Have a completed run's details available as explicitly labelled saved evidence.
6. Confirm evaluation belongs to the current snapshot. Intake evaluation runs after publication, so “not ready yet” is an honest temporary state.
7. The one-minute submission video and three-minute live demo are separate deliverables. The supplied guide says submissions close **September 27 at noon PDT**; verify any newer organizer announcement.

## Main sequence

| Time | Manual action | Explain |
|---|---|---|
| 0:00–0:15 | Show map and source/fixture disclosure. | “This is a published map of conversation goals. A product team can inspect aggregate patterns without opening a transcript. Providers do process the source text.” |
| 0:15–0:30 | Ask **“Which coding workflows have the most distinct people repeating requests?”** if that category exists. Otherwise use **“Which workflows have the most distinct people repeating requests?”** | “This is a fresh request. Inspect the plan: workflows, distinct people, repeat-request signal, sorted by count.” |
| 0:30–1:10 | Show the plan and execution stages. | “GLM on Vultr writes two programs, using pandas and standard Python. They run in separate disposable gVisor containers on our sandbox VM. No transcript or model key enters those containers.” If repair occurs: “A check failed; it gets one bounded repair. We show that.” |
| 1:10–1:35 | Read the answer and open **Run details**. Point to A/B code, runtime, limits, container removal, agreement and map checks. | “These are executed counts. Agreement and independently computed map totals catch some errors. They do not prove every question was interpreted correctly.” Use the displayed denominator; never memorize a finding. |
| 1:35–2:05 | Run **containment check**. Wait for timeout, cleanup, destructive fixture, clean follow-up and leak rejection. | “The supervisor terminates a runaway program. The destructive fixture runs only inside the disposable gVisor container. The root stays read-only, cleanup is verified, and the gate refuses a per-person export.” Use the receipt's refusal count; it is image-dependent. |
| 2:05–2:30 | Select a returned workflow; inspect needs/problems and the friction lens. | “This gives the team an area to investigate. Repetition and correction are signals, not proof of dissatisfaction or model failure.” |
| 2:30–2:50 | Open **Evaluation**. Show one successful check and one real limitation. | “We reconcile counts and test leaks and containment. Reference labels are model-assisted. Correction currently misses its target; complaint support is too small to score.” Read the current report if results changed. |
| 2:50–3:00 | Close on the use case and reusable boundary. | “The contribution is a reproducible path from private conversation data to constrained, inspectable executed analysis. Other text-chat datasets can use the validated import format; each new domain needs its own evaluation.” |

If the question takes longer, spend less time browsing the map. Do not skip containment and claim it ran. If it has not finished, say so and use the labelled recording or saved receipts.

## Optional intake variant

Use intake after rehearsing the main sequence comfortably within three minutes, or during Q&A. It changes the snapshot, so finish it **before** starting the question. Replace map browsing, not execution evidence.

- It uses a prepared WildChat batch. GLM facet extraction happened before the demo; Jev classification and four friction decisions happen live. Say that explicitly.
- `/api/intake/status` must show `ready: true`. If consumed, an intentional presenter **Reset intake** restores its base snapshot; first verify no newer unrelated build needs to remain current. Never reset during another analysis.
- The reviewed event feed is presenter-only routing metadata, with no conversation summaries. Each event is real, but the stream is **provisional** until gating and publication finish.
- Wait for the returned `published_snapshot_id` to become the displayed map before quoting numbers. Evaluation may still be running.
- An outage or gate rejection is a visible failure. Do not present partial events as published successful intake. Reload to inspect the current snapshot after an unexpected error.
- Imported custom datasets do not support this WildChat-specific intake adapter yet; rebuild their isolated workspace instead.

## Video brief beat (optional, 20–30 s)

Best right after an intake publishes a new snapshot, or as the closing beat.

- Click **Video brief** in the toolbar. For a snapshot that already has a brief, it plays at once; otherwise click **Direct the video**. The director takes about 20 s: read the published map → GLM directs the storyboard → the gate checks every word and number. Say: “The model directs and writes the words; it may not write a digit. Every number is filled by code from the published map.”
- Point at the storyboard rail (click a scene to jump), the **Gate** checks and the **Numbers in the words** strip. **Download MP4** appears when the server render finishes (about 2–3 minutes on the app VM).
- A cut that fails the gate twice is not shown (`brief_rejected`); say so and use **Direct a new cut** or the previous cut.
- Before the demo, open the brief once on the snapshot you will start from, so its first cut is cached.

## Fallbacks

| Condition | Response |
|---|---|
| Wrong interpretation | Point out the plan and rephrase once. A correct calculation of the wrong plan is not a correct answer. |
| Programs disagree or gate fails | Show the failure/repair receipt: “No answer was released.” Label any saved passing run as saved. |
| Provider/budget failure | Presenter mode reserves capacity but cannot fix a provider outage. Show the existing map and labelled recorded execution. |
| Sandbox unavailable | Claim no successful new live answer. Show health/error state and historical receipts. |
| Wi-Fi failure | Play `demo/logless-demo.mp4`, introduced as a recording. |

## Judge questions

- **Why sandbox instead of SQL?** A fixed aggregate query could use SQL. The sandbox provides a constrained way to execute generated analysis code; this prototype intentionally limits questions to counts, people, signals and ranking. Do not claim arbitrary statistical analysis.
- **Why two programs?** Different implementations catch some mistakes. Both use the same model family and can agree on the same error. Deterministic validation and independent published totals add checks.
- **Is it private?** No transcripts or individual summaries reach the analyst UI. Counts can include small groups; providers see inputs; this is not differential privacy or proof against inference. Sensitive production use needs further privacy and access-control work.
- **Can it use any dataset?** Text assistant conversations in the documented JSONL format, in an isolated workspace. Import validation and synthetic tests establish mechanics, not classification quality across every domain. Arbitrary tables, images and audio are unsupported.
- **What does friction mean?** Observable correction, repetition, assistant limits or complaints. Iterative writing and retries can be legitimate use; a flag is an investigation signal, not an individual satisfaction judgment.
- **Why Jev and Fireworks?** Organizers approved their use. Jev provides typed classifications; Fireworks embeds generalized facets. Agent planning, code generation and explanations use Vultr Serverless Inference. The 0.65 cutoff is selected-option probability, not a measured guarantee of accuracy.
- **What was built here?** Point to `BUILT_DURING_HACKATHON.md`; attribute gVisor, model providers, dependencies and datasets. Do not claim the sandbox runtime or datasets as our invention.
