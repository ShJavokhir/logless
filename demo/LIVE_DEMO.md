# Three-minute live demo: runbook

**URL:** https://144-202-110-2.sslip.io

**Presenter link:** open it once before going on stage, as `https://144-202-110-2.sslip.io/?presenter=<PRESENTER_KEY>`. The key is in the repo-root `.env`, which is never committed. The app stores the key in the browser and removes it from the URL. Your runs then draw on a reserved budget, so public traffic can't exhaust the demo.

**Before you start** (5 minutes ahead):
- Use a laptop at 1440×900 or larger, browser zoom 100%, light mode.
- Check that `https://144-202-110-2.sslip.io/api/health` returns `"status":"ok","sandbox":"reachable"`.
- Click "What's not working?" once to warm up. Leave the page on the default map, with nothing selected.

| Time | Do | Say (gist) |
|---|---|---|
| 0:00–0:20 | Default view. Point at the header and at "Aggregate insights only". | "Assistant teams sit on the most honest feedback there is, what people actually try to do, and nobody can ethically read it. This is 5,000 real conversations from the public WildChat dataset. Nobody on the team reads any of them." |
| 0:20–0:45 | Point at the **Key finding** card, then click **Show where it breaks**. | "An agent read every conversation and grouped them into 34 workflows by the user's goal. First finding: software is 21% of conversations but 31% of friction. In 'Fixing errors', 4 in 10 conversations show a correction, a repeated request, a limit or a complaint." |
| 0:45–1:05 | Scroll the detail panel: people vs conversations, signals, needs, "Where it breaks". Click **Generate fictional user story**. | "Every problem is backed by evidence IDs. The story is fiction, labelled as such, and generated only from the published aggregate." |
| 1:05–1:45 | **Ask a question** → the chip "Which coding workflows have the most distinct people repeating requests?" While it runs, point at the loop strip. | "This is the agent. GLM on Vultr interprets the question into a plan you can read. It writes a pandas program without seeing any data. The program runs in a fresh gVisor container on a separate VM with no API keys and no internet. A gate checks every number against a trusted reference before I see it." |
| 1:45–2:05 | Open **Run details**: the code, the receipt (runsc, limits, container removed) and the gate checks. | "Every answer has a receipt: the code hash, the runtime and the verdict." |
| 2:05–2:30 | Scroll down to **Run containment check**. | "Agent-written code is untrusted. A runaway program is killed at its 2-second deadline and the container is removed while the app stays healthy. Then a program that tries to export per-person rows gets rejected by the gate." |
| 2:30–2:50 | Footer → **Evaluation**. | "We measure it. There are zero detected canary leaks and counts reconcile exactly. Jev agrees with two independent labellers on 81% of workflows, about the same as they agree with each other. Where we miss, like correction recall, we show it." |
| 2:50–3:00 | Close the dialog and go back to the map. | "GLM on Vultr Serverless Inference, Jev by TypeSafe, embeddings by Fireworks, and gVisor on Vultr. Every team building an assistant needs this." |

**Fallbacks**
- **A live run fails or hits its budget:** the UI says so honestly, and the saved snapshot stays browsable. Say "the gate refused it, which is the point", then open a previous run from Run details, or show `demo/logless-demo.mp4`.
- **The sandbox is unreachable:** the map, search and stories still work, and live questions show "Live analysis unavailable". SSH in and check with `systemctl status logless-runner` on the sandbox VM.
- **Wi-Fi fails:** play the one-minute video.

**Judge Q&A (short answers)**
- **"Why an agent and not a SQL dashboard?"** The agent reads unstructured text in 55 languages and turns it into generalized facets and workflows. It also turns plain-English questions into verified analyses. The sandbox and the gate make its code safe to run and its numbers safe to trust.
- **"How is this different from Clio?"** It's open, small and measurable: independent reference labels, external labels from other labs, planted canaries, and a clean-room sandbox with an egress gate. We don't enforce a minimum cluster size; we generalize wording instead and say so.
- **"Why TypeSafe Jev?"** It gives calibrated, typed decisions in about 0.25 s per conversation. Before the cutoff it beats GLM Flash on two of three friction signals (0.87 and 0.92 versus 0.84 and 0.88). We use the 0.65 cutoff to favour precision, and the rest is shown as "unclear".
- **"Is it private?"** The browser only ever gets allowlisted aggregates, and the sandbox gets no text. It is not differential privacy, and the model providers do see raw text; the README says so.
- **"What did you build this weekend?"** Everything. See `BUILT_DURING_HACKATHON.md` and the commit timestamps.
