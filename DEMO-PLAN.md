# logless: the stage demo and the build behind it

## The promise

Help a product team decide what to improve without reading private conversations.

The audience should leave with one example: people use an assistant to keep shared plans current; repeated changes create friction; the product opportunity is to preserve the latest agreement through the next action.

This is a proposed presentation narrative. The current 600 / 108 / 46 figures and Alex story are authored mock fixtures. They are useful for layout rehearsal, not evidence of discovery. The real pipeline determines the final workflow, counts, and supported need. Change the script if the results differ. Do not tune classification to recover the mock numbers.

Assumptions: a three-minute live slot, a projected 16:9 browser, one presenter, and the existing synthetic-only scope. Remaining build time and teammate ownership are not yet confirmed. The photographed room shows why small panel text is unsuitable; it does not establish a tested minimum font size.

## Presentation choice

| Approach | Benefit | Cost |
| --- | --- | --- |
| Enlarge the existing workspace with browser zoom | Fast; uses the current controls | Navigation, charts, and side panels still compete. Zoom changes layout and introduces scrolling. |
| Add a presentation view to the existing product | One readable task per screen; uses real state and results; works with your spoken explanation | Requires a small view layer, stage navigation, and a concise story format. |
| Present screenshots or a recording | Predictable framing and timing | Cannot establish that a request ran live. Suitable as a clearly labeled backup. |

**Choose the presentation view.** Keep the working explorer for normal use and questions after the demo. The stage view shares its data adapter and public results. It does not contain a second set of example results disguised as live output.

## Three-minute run of show

The spoken copy below is a rehearsal script. Statements about real execution, discovery, privacy boundaries, and containment are permitted only after their corresponding build gates pass.

| Time | What the audience sees | What you do and say | What must be true |
| --- | --- | --- | --- |
| **0:00–0:15** | One question: **“How do you improve an assistant without reading private chats?”** A clear synthetic-data label. | “Personal assistants see some of our most private conversations. Product teams still need to know what to improve. Logless helps them find patterns without opening individual chats.” | The public interface and API expose approved aggregates only. Do not claim providers or infrastructure operators cannot access the source. |
| **0:15–0:40** | Four large category circles. One selected category expands to at most three named workflows. **[N] synthetic conversations** is readable. **Analyzed before this demo** stays visible. | “This is a synthetic workspace. We analyzed these conversations before today. The circles show how people use the assistant. One workflow crosses messages and calendars: keeping a shared plan current as people change their minds.” Select the actual discovered workflow. | A real extraction, discovery, classification, and publication run produced the snapshot. Circle area follows conversation count. Names and totals come from that snapshot. |
| **0:40–0:55** | Large query: **“coordinating with other people.”** Three matching workflows remain visible, with their original counts. | “I can find that need in everyday language. Search highlights relevant published patterns. It does not open conversations or create new statistics.” Submit the query once; do not browse multiple queries. | Jev returns validated IDs from the current public hierarchy. No private records enter this request. Search must not alter counts or layout. |
| **0:55–1:35** | Large **“What’s not working?”** action. Running state: **Preparing → Running → Checking**. Then one result: **[F] of [C] conversations show friction**, with a clear denominator. | Click the analysis action. While it runs: “Now I’ll measure where this workflow breaks down. The agent prepares an analysis, runs it in an isolated environment, and checks the result.” After success: “Here, [F] of [C] conversations show a correction, complaint, or unresolved action error. That does not mean the rest succeeded.” | A generated program actually ran in a disposable sandbox. The server reconciled the result against trusted counts. Completion comes from a validated artifact, not a timer. |
| **1:35–2:10** | **Generate example**. Then three large lines: **Goal: Keep a shared plan current. Break: An old constraint returns. Need: Carry the latest agreement forward.** Persistent **Fictional example** and **Not a customer quote**. | “A number tells us where to look. This fictional example makes the need concrete. Alex changes a shared plan, but an old constraint returns in the next step. Alex repeats the update. The opportunity is to carry the latest agreement into the next message and reminder.” | GLM uses only approved aggregate evidence. A validated short form and full story describe the same supported need. Unsupported detail and evidence IDs fail validation. |
| **2:10–2:35** | A separate **Execution limit test** view. Run → actual termination → **Sandbox removed** → **App healthy**. Show measured elapsed time without a fake stopwatch. | “Because an agent can write faulty code, its work needs limits. This fixed test never finishes. The runner stops it, removes its environment, and verifies the app is still healthy.” Click once; wait for actual outcomes. | A fixed infinite loop runs with a two-second deadline. The runner verifies termination and removal. A subsequent health check succeeds. A timeout animation alone is insufficient. |
| **2:35–2:50** | Close on **“Keep the latest agreement through the next action.”** Subline: **A product hypothesis to test.** | “That gives the product team a specific improvement to test. Vultr hosts the app and execution. GLM discovers and explains; Jev classifies and finds. The team sees the pattern without opening the conversation.” | This is a proposed product response to the evidence, not a measured causal diagnosis or a promised improvement. Stack claims reflect the deployed system. |
| **2:50–3:00** | Hold the last screen. | Buffer for a slow response or a natural pause. | Do not consume this buffer with an architecture tour. |

If the real pipeline finds a different useful workflow, substitute it consistently in the map, analysis, story, and close. Keep the narrative structure. Use actual validated counts; never narrate 46/108 from memory.

## What changes for the big screen

- Design against a 1920 × 1080 stage canvas. Use 64–80 px headings, 40–48 px main statements, 120–160 px key numbers, and at least 32 px essential labels. These are starting targets; test in the room.
- Keep about 96 px of horizontal margin. Keep essential content out of the bottom 15%, where people or equipment may obscure it.
- Use charcoal on white. Keep the existing blue for the selected workflow and the primary action. Faint gray is unsuitable for required text on this projector.
- Show one question, one primary action, and one conclusion at a time. Limit the visible hierarchy to one level, then focus a parent. Keep the two-level structure in the data.
- Put cluster names outside small circles. Show no more than four category labels or three selected workflow labels at once. Other workflows remain reachable through the normal explorer.
- Do not project a sidebar, a narrow detail panel, a 100-word story, code, a terminal, receipts full of IDs, or speaker notes. Keep detailed evidence available for questions.
- Separate the audience view from narration. Use printed notes or a second display. Stage navigation must never show notes on the projected screen.
- Right/left arrows move between views; Enter activates the visible primary action. Navigation never fabricates completion. Do not reset an active job when moving back.
- Motion should show selection or a result arriving. Hold completed text still while speaking. Preserve reduced-motion behavior.
- Test the exact browser, full-screen mode, projector resolution, and room lighting. Ask someone at the last row to read the workflow name, denominator, fictional label, and termination outcome without prompting. Increase type and remove content until they can.

## Work backward from visible proof

| Visible promise | Smallest real capability | Current local state | Gate before presenting it as real |
| --- | --- | --- | --- |
| A useful workflow emerges | Synthetic source fixture → private facets → model-discovered hierarchy → classification → computed aggregates → approved snapshot | Authored aggregate fixtures only | A clean rebuild produces a validated snapshot. Private generator expectations are absent from inference inputs. Counts reconcile. |
| Search understands a concept | Jev relevance call over public cluster descriptions | Deterministic keyword matching | A live query and an unrelated query return valid matches/no matches with unchanged counts. |
| An agent measures friction | GLM-generated bounded analysis; disposable runner; output validation; safe job polling | Simulated run and authored metrics | Saved generated program, execution receipt, validated result, and one bounded repair test. No fixture fallback. |
| A finding becomes a relatable need | GLM story generation from approved evidence, including a concise stage summary | Authored 99-word example | Goal, obstacle, and need carry valid evidence references; fictional disclosure remains; generated text is validated before display. |
| Faulty work is contained | Fixed infinite loop, external deadline, container termination/removal, app health verification | Not implemented | On the deployed VM, the test is stopped and removed; a subsequent health check or ordinary request succeeds. |
| The audience can follow | Presentation view using the same adapter and result state | Dense explorer and a mock walkthrough video | Every critical statement is readable from the last row; no scrolling or cursor hunting is required. |
| The demo survives real conditions | Public HTTPS deployment, persisted snapshot, honest errors, rehearsal and backup | Local frontend only | A fresh browser completes the live loop without a terminal or manual response editing. |

## Build order

Do not build the backend in screen order. Test the riskiest external dependencies first, then build one complete path.

1. **Establish the runtime and account access.** Confirm the Vultr VM, inference model access, TypeSafe access, and the container runner. Make minimal successful calls. Prove the fixed containment test on the target VM. This reveals blockers before pipeline work expands. No new infrastructure is implied to exist yet.
2. **Freeze the public contracts and delivery mode.** Agree on snapshot, search, analysis, story, containment, and health payloads. Add a real HTTP adapter with runtime validation. Use explicit mock or live mode. A failed live call stays a visible failure; it never switches to fixtures.
3. **Produce one genuine published snapshot.** Create the reproducible synthetic dataset; keep generator labels private to evaluation. Run extraction, discovery, classification, trusted aggregation, and publication checks. Save provenance and publish atomically. Rehearse with the actual finding, not the initial mock title.
4. **Complete the analysis path.** Implement the two fixed questions, generated code execution, result reconciliation, safe polling, one repair attempt, and persistent outcomes. Use the runner already proven in step 1. Keep the last good snapshot available after failure.
5. **Complete search and the story path.** Wire Jev search. Generate and validate a grounded story plus three concise stage fields. Persist the story per snapshot and cluster. Show “Previously generated” on a cache hit; never claim it was just generated.
6. **Add the stage view to the existing Next.js app.** Reuse the current adapter and shared result state. Render focused category → workflow → result views. Add short story presentation, presenter navigation, large status messages, and the dedicated containment beat. The planner preview is not this implementation.
7. **Deploy, rehearse, record.** Verify public HTTPS, the complete live flow, privacy publication checks, recovery, and containment. Time three rehearsals. Record a genuine backup and the required submission video, preserving precomputed/live labels. The existing 30-second mock film is not proof of the live system.

Frontend and backend can proceed against the agreed contracts, but do not start competing implementations in another owner's area. Current local source contains no backend. A teammate may have work elsewhere; confirm before assigning the remaining blocks.

## Minimal architecture and handoff

```text
normal explorer       presentation view
       \                  /
        shared frontend state + adapter
                       |
                 public API on Vultr
                       |
      +----------------+----------------+
      |                |                |
 saved snapshot   bounded jobs     story/search
      |                |                |
 offline pipeline  fresh sandbox   GLM / Jev
                       |
             validate → persist → publish
```

Use the current Next.js frontend. A second frontend framework is unnecessary. Keep the backend stack selected by its owner if it meets the contracts. No extra queue service or vector database is needed for this scope.

The current frontend contracts explicitly encode mock results (`simulated: true`, null sandbox IDs, and `Local mock`). Do not relabel them. Introduce a discriminated live/mock result type so a simulated result cannot satisfy the live receipt UI. The shared UI needs:

- Published snapshot identity, hierarchy, exact counts, provenance, and safe evidence IDs.
- Analysis results tied to that same snapshot, plus verified execution/validation outcomes.
- Story fields for goal, obstacle, and need, each with supporting evidence IDs, alongside the full story. Each short field should fit about 12 words; the final layout handles longer validated output without hiding content.
- A separate containment result with deadline, measured duration, termination status, removal status, and subsequent health status. Missing evidence stays pending/failed; a frontend timer cannot manufacture it.
- A proposed product action clearly labeled as a hypothesis. Keep it separate from observed evidence and fictional illustration.

TypeSafe's current [quick start](https://docs.typesafe.ai/introduction/quickstart) uses `state` and typed `questions` at `/v1/systemone`. It is not a chat-completions payload. Account/model access still requires an actual smoke test. Docker containers have no resource limits by default; explicit limits and a trusted external deadline are required. See [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).

## Rehearsal and fallback

The scheduled 40-second analysis beat includes narration while the job runs. The spec's 25-second analysis and 12-second story targets must be measured on the deployment; they are not promises. If those targets are missed repeatedly, simplify bounded requests before rehearsal.

If a live call fails, say so. Keep the genuine saved snapshot visible. Switch deliberately to a separately labeled recording of a previously successful real run when needed. Do not replace the failed request with a simulated success. The containment requirement remains a real execution requirement, even when a recording is used for presentation recovery.

The first complete rehearsal should establish four things: the useful finding is real, the live actions finish within the slot, the safety test is visible and verified, and the last row can read every essential label. More features do not compensate for a failure in one of those four.

## This planning pass

The editable visual proposal is saved in `frontend-evidence/stage-storyboard.html` as a Codex visualization fragment.

Created a stage-by-stage visual proposal and this script/build plan. The existing application and backend contracts remain unchanged. The stage preview uses mock figures and illustrates target outcomes; it performs no model calls or sandbox work. The frontend, runtime, pipeline, integration, and deployment items above remain implementation work.

Browser review of all eight proposed screens passed at 1024 px and 390 px widths, with no horizontal overflow or console warnings/errors. At the desktop preview width, every stage screen retained a 16:9 ratio. This checks the proposal's layout and navigation; actual projector legibility and live product behavior remain untested.
