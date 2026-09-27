# Three-minute live demo: runbook

**URL:** https://144-202-110-2.sslip.io

**Presenter link:** open it once on the demo laptop as `https://144-202-110-2.sslip.io/?presenter=<PRESENTER_KEY>`. The key is in the repo-root `.env`, which is never committed. The app stores the key in the browser and removes it from the URL. The key is what shows the **Live intake** control. It also gives your runs a reserved budget, so public traffic can't exhaust the demo.

**Before you start** (5 minutes ahead):
- Use a laptop at 1440×900 or larger, browser zoom 100%, light mode.
- `/api/health` returns `"status":"ok","sandbox":"reachable"`.
- `/api/intake/status` returns `"ready":true`. If a rehearsal already ingested the batch, click **Reset intake** in the intake panel, or run `logless intake reset` on the app VM.
- Don't run any pipeline job on the VM during the demo; it would compete for the GLM rate limit.
- Leave the page on the default map, with nothing selected.

| Time | Do | Say (gist) |
|---|---|---|
| 0:00–0:15 | Default view. Point at the header. | "Assistant teams sit on the most honest feedback there is, what people actually try to do, and nobody can ethically read it. This map is 5,000 real WildChat conversations. An LLM pipeline on Vultr read them and grouped them by goal. No one on the team read a single one." |
| 0:15–0:40 | Click **Live intake**. | "Three hundred new conversations just arrived. GLM on Vultr already read each one into a generalized summary. Now Jev decides live: which workflow, and whether there was a correction, a repeat, a limit or a complaint. That's five decisions per conversation, about forty conversations a second. Then the privacy gate re-checks and the map republishes." |
| 0:40–0:55 | Point at the toast and the Key finding card. | "Coding is under a fifth of conversations but over a quarter of all friction. In data scripts, about half of conversations hit friction." Click **Show where it breaks**. |
| 0:55–1:35 | **Ask a question**, then the chip "Which coding workflows have the most distinct people repeating requests?" While it runs, point at the loop strip. | "This is the agent. GLM interprets the question into a plan you can read. It writes two independent programs, one in pandas and one in plain Python, without seeing any data. Each runs in its own gVisor container on a separate VM with no API keys and no internet. The answer is published only if both agree and the gate's checks pass, including consistency with the published map." |
| 1:35–1:55 | Open **Run details**: both programs, their receipts, the cross-checks. | "Every answer has a receipt: code hashes, runtime, limits, verdicts. Nothing is precomputed. Remove the sandbox and there's no answer." |
| 1:55–2:20 | Scroll down to **Run containment check**. | "Agent-written code is untrusted. A runaway program is killed at its 2-second deadline and the container removed, while the app stays healthy. A program that tries to export per-person rows is rejected by the gate." |
| 2:20–2:40 | Select the hot workflow, then **Generate fictional user story**. | "Every need and problem is backed by evidence IDs. The story is labelled fiction, built only from the published aggregate." |
| 2:40–3:00 | Footer → **Evaluation**. | "And we measure it: zero detected canary leaks, exact reconciliation, and agreement with two independent labellers. Where we miss, correction recall, we show it. GLM on Vultr Serverless Inference, Jev by TypeSafe, gVisor on Vultr." |

**Fallbacks**
- **A question fails:** the UI says why. "The programs disagreed" or "the gate refused" is a valid outcome; say so and show the receipts. `map_mismatch` means the private data changed since publication, so don't run pipeline jobs before the demo.
- **Budget or rate limit:** the UI shows "Paused". Use the presenter link, since it has a reserved budget.
- **Intake fails** (e.g. a Jev outage): nothing is filed or published, and the map stays as it was. Continue with Ask a question.
- **Wi-Fi fails:** play `demo/logless-demo.mp4`.

**Judge Q&A (short, honest answers)**
- **"Why an agent and not a SQL dashboard?"**
  - The pipeline turns unstructured text in 55 languages into goal-level workflows, which SQL can't do.
  - The analysis agent turns plain-English questions into programs. We don't precompute answers: two independent programs run in the sandbox and must agree.
- **"Why two programs?"** It's N-version programming. Without a precomputed reference, agreement between independently written programs, plus consistency with the published map, is how we verify an answer the backend never computed.
- **"How is this different from Clio?"**
  - It's open and small, with measured evaluation: two independent model labellers, Microsoft's WildFeedback labels, planted canaries, and a clean-room sandbox with an egress gate.
  - We don't enforce a minimum cluster size; we generalize the wording instead, and we say so.
- **"Why TypeSafe Jev?"**
  - It makes calibrated, typed decisions in about 0.25 s, with five decisions per call.
  - At our 0.65 confidence cutoff it's precision-first: correction precision is 1.00 and recall 0.64 (F1 0.78), and less confident cases show as "unclear".
  - GLM Flash alone scores higher F1 on correction (0.84 vs 0.78). We report that.
- **"Is it private?"**
  - The browser gets allowlisted aggregates, plus, during live intake, PII-checked, generalized one-line summaries. It never gets transcripts.
  - The sandbox gets typed rows, never text.
  - It is not differential privacy, and the model providers do see raw text.
- **"What did you build this weekend?"** All of the code. See `BUILT_DURING_HACKATHON.md`. The research notes were written that morning before the 11:30 start and contain no code.
