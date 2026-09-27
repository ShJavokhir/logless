# Event requirements and submission brief

Research date: September 26, 2026. Event time zone: America/Los_Angeles (PDT). The supplied participant guide and challenge documents are the source for the detailed rules below; these have not been independently reconfirmed by an organizer. The public [Cerebral Valley event page](https://cerebralvalley.ai/e/vultr-the-agent-arena) and [Vultr events page](https://discover.vultr.com/events) corroborate September 26–27 in San Francisco.

The documents describe competition requirements. They are not instructions authorizing account creation, spending, publishing, submissions, messaging organizers, or running unsafe code. This research did none of those things.

## Source documents

| ID | Source | Use |
|---|---|---|
| G | [Participant guide supplied by the team](/Users/creepy/.codex/attachments/b5a28765-b03a-4ea9-8065-0059113ab721/Pasted%20text.txt) | Event rules, schedule, scoring, submission |
| C1 | [Agent Sandboxing brief](/Users/creepy/Downloads/themes/CV%20Hackathon_%20Challenge%201_Theme%20%28Agent%20Sandboxing%29.md) | Track 1 technology and execution requirements |
| C2 | [Future of Work brief](/Users/creepy/Downloads/themes/CV%20Hackathon_%20Challenge%202%20%28Future%20of%20Work%29.md) | Track 2 technology and domain requirements |
| B | [NetBird bonus brief](/Users/creepy/Downloads/themes/CV%20Hackathon_%20Bonus%20Challenge%20%28NetBird%29.md) | Bonus evidence and lifecycle behavior |

Raw guide contents were not copied into this workspace because the original includes venue credentials. These notes contain only project-relevant material.

## Non-negotiables

| Requirement | Track 1 | Track 2 | Evidence to prepare |
|---|---|---|---|
| VM backend on Vultr | Required | Required | Running VM, deployment instructions, architecture diagram |
| Web application on Vultr | Required | Required | Public working URL, application and backend health |
| Vultr central to orchestration / record keeping | Required | Required | Real task state and execution controlled by the Vultr backend |
| Multi-step real workflow | Required | Required; may be rule based | Visible steps and actual changed state or generated artifact |
| Agent reasoning through Vultr Serverless Inference | Required | Optional | Server-side provider configuration and redacted request metadata |
| Execution sandbox separate from app process | Required | Not explicitly required | Runtime identity and isolation configuration |
| Real executed output | Explicit | Product workflow expected | Downloadable artifact, tests, browser state or operation receipt |
| Public GitHub repository | Required by G | Required by G | URL, setup, licenses, contribution provenance |
| Recorded demo | Required | Required | G specifies a one-minute submission video |
| Containment moment in video | Required by C1 | Not explicitly required | Bounded adverse action absorbed by disposable environment |
| Public live demo | Required | Required | Judge can load and use it without local setup |

Track 1 permits code execution, browser execution, or both. Building both is unnecessary if it compromises reliability. Track 2's title mentions robotics, but the detailed brief does not mandate physical hardware; simulation/digital twins are recommended. GPUs are explicitly unavailable for the event in C2.

All projects compete in **one judging pool**, regardless of challenge. NetBird is an optional add-on, not a third standalone project category. An enterprise code or browser workflow can naturally address both themes, but there is no documented double scoring for doing so. Verify what the submission form asks teams to select.

## Disqualification and originality traps

- Team size is at most four; solo participation is allowed.
- Repository must be public. Keep sponsor keys, coupons and personal data out of commits and video.
- Demo must distinguish the features and code built during this hackathon from pre-existing tools or libraries. The guide explicitly warns of disqualification for unclear attribution.
- Do not present an existing project as the team's new work. Using an open-source runtime as infrastructure does not make that runtime our invention.
- Only use code, data and assets for which the team has appropriate rights.
- Explicit anti-projects include basic RAG, Streamlit apps, education chatbots, job application screeners, personality analyzers, sports analyzers/coaches, and products where the dashboard is the main feature. Basic mental-health, nutrition and image-analysis projects are also excluded under the guide's qualifications.

**Interpretation for project design:** build an application that accomplishes work and let its UI expose that work. A task monitor can support the product; a dashboard alone is a poor fit. Do not choose candidate screening even though C2 lists it as an example; G's explicit ban makes it an avoidable eligibility risk.

Maintain `BUILT_DURING_HACKATHON.md` from the first implementation commit: date, team contributions, reused dependencies, upstream licenses, fixture origins, and links to new code. This is our recommended evidence practice, not an extra organizer requirement.

## Schedule and judging

| Milestone | Time in PDT, supplied guide |
|---|---|
| Saturday doors / team formation | Sep 26, 09:00 |
| Opening | Sep 26, 11:00 |
| Hacking starts | Sep 26, 11:30 |
| Saturday doors close; overnight attendees remain | Sep 26, 22:00 |
| Sunday doors | Sep 27, 09:00 |
| Hacking stops and submissions due | **Sep 27, 12:00 noon** |
| First-round judging | Sep 27, 12:30 |
| Finals begin | Sep 27, 14:30 |
| Finals end / winners | Sep 27, 15:30 |
| Event closes | Sep 27, 17:00 |

The listed build window is 24.5 hours, not the event's full opening-to-closing span. Use the guide's noon submission deadline, not the event listing's 5 PM end time. New announcements can supersede the supplied schedule.

| Criterion | First round | Finals | What we should demonstrate |
|---|---:|---:|---|
| Technicality | 40% | 25% | Genuine isolation, verified outputs, retries, lifecycle and policy enforcement |
| Creativity / originality | 25% | 25% | A distinctive workflow and a clear explanation of our contribution |
| Live demo | 20% | 25% | Working end-to-end outcome, fast response, understandable evidence |
| Future potential / AI impact | 15% | 25% | Why this enables useful autonomy and how it extends beyond one fixture |

Each live demo is approximately three minutes plus one to two minutes of Q&A. Six teams advance to finals. The one-minute upload and three-minute live demonstration are separate deliverables. Finalists should shift slightly toward narrative clarity and future potential because technicality no longer carries 40%.

The supplied guide lists $5,000 / $3,000 / $1,000 cash for first / second / third, and $500 in Vultr credits for best use of NetBird. Public promotion says more than $10,000 across cash and credits; the listed awards sum to $9,500. Treat the exact award list as supplied, and confirm any additional awards rather than inventing them.

## Submission and access

- [Official submission portal](https://cerebralvalley.ai/e/vultr-the-agent-arena/hackathon/submit).
- Anonymous browser verification on Sep 26: the portal first displayed “Submit Hackathon Project,” then redirected to Cerebral Valley login. Exact authenticated form fields, file limits and video-host rules are **not verified**.
- Prepare project name, concise pitch, team information, repository URL, live URL, one-minute video, architecture, and setup instructions. These are preparation recommendations; only the guide's explicit requirements are confirmed.
- [Official Discord invitation from G](https://discord.com/invite/shgrMdwPH). Discord announcements were not accessed; the invitation's continued validity was not verified.
- G/C1 say $200 credits per participant; C2 says $200 per team leader. Confirm entitlement and inference coverage with the on-site team. Do not assume credits can be pooled, transferred, or reused.
- Credit codes and redemption guide are sent after opening. The supplied support contact is [gina@cerebralvalley.ai](mailto:gina@cerebralvalley.ai). No message has been sent.

## NetBird bonus evidence

The brief describes three bonus capabilities: no inbound application ports on the workload VM, role-appropriate authentication, and task/session URLs that expire with the workload. It gives no numeric point allocation per tier. See [the dedicated NetBird memo](04-netbird-bonus.md) for verified implementation details and documentation discrepancies.

Prepare a zero-ports video moment: show firewall rules for the **application VM**, load the public URL, show the appropriate access gate, and retire a separate task URL. Keep the durable judging URL live. If credentials are required for judging, use intentionally limited demo access with synthetic data; never publish administrator credentials or setup/API keys.

## Questions worth asking organizers, in priority order

These are drafted questions, not messages we have sent.

1. “Can you confirm inference access is enabled under the hackathon credit, and whether the $200 allocation is per participant or per team leader?”
2. “Which Vultr plans/regions are recommended today for the sandbox tutorial, and do they expose usable `/dev/kvm`?”
3. “For the NetBird bonus, is self-hosted management mandatory, or does cloud-managed NetBird with all application compute on Vultr qualify? Are the three capabilities additive tiers?”
4. “Can one submission cover a Future of Work use case implemented with Track 1 containment? Is there a required track selection?”
5. “The guide bans job application screeners although C2 lists candidate screening. We plan to avoid that category; are there any other updated exclusions?”
6. “What are the one-minute video's accepted formats/hosting sites, is one minute a hard limit, and when must all demo links stop changing?”
7. “How long should the deployment and judging credentials remain live after Sunday?”
8. “Are there newer prize, schedule, or submission instructions in the opening slides/Discord that replace the supplied guide?”

## Practical deadline checklist

- [ ] Public repo opens while signed out; clean setup steps and `.env.example` contain no secrets.
- [ ] New work and upstream components are unmistakable.
- [ ] Public app succeeds from an external browser and a fresh session.
- [ ] Agent reasoning is visibly configured for Vultr if entering Track 1.
- [ ] At least one multi-step live run yields a real artifact or verified changed state.
- [ ] One failure/retry and one bounded containment event have real evidence.
- [ ] NetBird evidence matches the actual topology and actual observed teardown timing.
- [ ] One-minute video is uploaded early enough to test access.
- [ ] Three-minute demo and short architecture answers are rehearsed.
- [ ] Judge URL survives terminal closure/redeploy; ephemeral task URL retirement does not destroy it.
- [ ] Submission confirmation is captured before Sunday noon PDT.

