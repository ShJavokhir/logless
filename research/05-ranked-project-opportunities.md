# Ranked project opportunities

Research date: September 26, 2026. These rankings are our judgment about this event, not predictions of winning or validated customer demand. Working names are placeholders, not trademark checks. The team has not selected a project.

## Recommendation

**First choice for delivery confidence: ProofPatch — repair a bounded function or import adapter in a disposable sandbox, check it against an externally enforced acceptance contract, and give the reviewer an evidence-backed patch plus a temporary review URL.** This ranking depends on the independent checker being real; a generic coding agent with green tests would have much weaker originality.

**Highest-upside alternative: Ops Rehearsal — test an operational change against a disposable copy of a business workflow before a human approves it.** It can be more original, but needs disciplined scope and credible state comparison.

**Most dependable business-workflow alternative: Reconcile Room — repair a messy reconciliation job, prove the invariants, and produce an auditable export.** This has fewer browser and deployment dependencies, but must go beyond the brief's generic CSV analyst example.

An independent review identified a particularly useful narrow version: **blocked-import recovery**. Repair one broken adapter, execute the import in a disposable environment, check identities/totals/no-partial-writes outside candidate control, then approve the exact result for a synthetic destination. Compare this concrete slice with a narrow Ops Rehearsal before choosing. [Independent critique and competing-product precedents](09-opportunity-review.md).

Choose the workflow first. A sophisticated sandbox without useful work can feel like plumbing; a polished assistant without actual execution fails the spirit of the event. All three can use the same small Vultr control plane and one disposable execution environment per run.

## Comparative ranking

Ratings are qualitative estimates for a small team in the supplied 24.5-hour build window. Strong demo reliability assumes prepared, disclosed fixtures and real live execution, not prerecorded results presented as live.

| Rank | Concept | Technical opportunity | Originality opportunity | Demo reliability | Implementation risk | Track / bonus fit |
|---:|---|---|---|---|---|---|
| 1 | ProofPatch: contract-checked repair + review room | High | Medium; higher only with a compelling counterexample/contract | High on bounded functions/adapters | Medium | C1 directly; developer operations C2; excellent NetBird fit |
| 2 | Ops Rehearsal: fork, simulate, compare, approve | High | High if actual consequences and stale approvals are demonstrated | Medium | High | C2; C1 conditional on real code/browser execution; excellent NetBird fit |
| 3 | Reconcile Room: executable data repair + invariants | Medium–high | Medium–high with controlled exception resolution | High | Low–medium | C1 code + C2 finance operations; good NetBird fit |
| 4 | FlowFix: reproduce and repair a broken web flow | High | Medium | Medium–high on our own app | Medium–high | C1 code/browser; good NetBird fit |
| 5 | Procurement Trial: compare quotes, prepare an order | Medium–high | Medium | Medium on a controlled portal | Medium | C1 browser + C2; good NetBird fit |
| 6 | Support Recovery: diagnose, rehearse, approve remediation | High | Medium | Medium | High if multiple external systems | C1 + C2; good NetBird fit |
| 7 | Data Contract Medic: repair a broken import pipeline | Medium–high | Medium | High | Low–medium | C1 + C2; moderate NetBird fit |
| 8 | Agent Trial Bench: test a workflow under failure/adversarial inputs | High | Medium | High on narrow tasks | Medium | C1; dashboard-only eligibility trap |
| 9 | Research with Receipts: screenshot-backed brief | Medium | Low unless verification is unusually strong | Medium | Medium from live web variation | C1 browser; weaker operations story |
| 10 | Generic sandbox chat / chart generator | Low–medium | Low; examples already in challenge | High | Low | Can satisfy basics; weak differentiation |

I would not build a general autonomous company, a generic multi-agent platform, a clone of an existing coding-agent UI, an entire ERP, or a novel hypervisor in this event. Each expands the amount of work without guaranteeing a clearer judged outcome.

## 1. ProofPatch

### User and job

A maintainer has a reproducible bug and wants a reviewable change with evidence. The product takes a small source archive or allowlisted public repository and an issue description, reproduces the failure, edits in isolation, and returns a diff with independently observed tests.

### Product flow

1. User selects a small repository fixture and describes the regression.
2. Vultr orchestrator records a run, source hash, initial test definition and resource budget.
3. A fresh sandbox runs the failing case. The UI shows real stderr and the baseline failure.
4. A Vultr-served model proposes a patch; the sandbox applies and tests it. One bounded retry can use the error output.
5. A trusted verifier outside candidate execution sends bounded JSON test inputs into a clean candidate sandbox and compares returned values to expected results held outside it. It never imports candidate code or trusts guest “passed” messages. For arbitrary repositories, a separate pytest run with unchanged tests is useful but should be described as a clean rerun, not tamper-resistant verification.
6. The review room displays diff, check results, logs, execution identity and downloadable artifact manifest. A NetBird URL plus application-level run authorization, or a dedicated read-only per-run service, grants a reviewer access to that run. A unique hostname alone does not provide run isolation.
7. Expiring that review session removes access; the main judge entry point remains live.

This is a proposal. No prototype was built or tested during this research.

### Distinctive contribution

The intended contribution is the **acceptance contract and its counterexamples**. Keep checks and expected results outside generated code's process and execution authority, restrict patch scope, reveal changed tests, and bind approval to the exact patch hash. A reviewer should see which behavior failed before, which checks pass after, and what remains unproven. A separate container with a candidate-controlled test process does not by itself establish this separation.

A hash proves artifact consistency relative to the recorded hash; it does not prove the orchestrator is honest or make the result a formal proof. Phrase the promise as “reproducible execution evidence,” not universal correctness.

### Existing work and the gap

[mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) provides a small coding-agent loop and multiple execution backends. [OpenHands](https://github.com/OpenHands/OpenHands) currently presents Agent Canvas, a broader self-hosted control center. These make “agent edits files and runs tests” insufficient as an originality claim. Our proposed focus is a bounded review contract: failed baseline, immutable checks, independent rerun, artifact lineage, and revocable review access.

[SWE-bench's Docker guidance](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/docker_setup.md) is valuable methodology, but its full recommended footprint is much larger than our small demo needs. Borrow the reproducible-evaluation principle; do not spend the event setting up a large benchmark suite.

### Minimal scope and stretch

| Must ship | Stretch only after the main flow works |
|---|---|
| One language, one prebuilt execution image | Multiple language images |
| Small, team-authored source fixtures | GitHub integration with approval and least-privilege credentials |
| Baseline failure and real patch | Two parallel candidate fixes |
| External checker, visible diff and meaningful held-out boundary case | Broader property/mutation testing |
| Downloadable patch + evidence | Browser preview of repaired application |
| One limited reviewer role | Organization policies and audit export |
| Bounded containment demonstration | Snapshot/resume or worker crash recovery |

Start with a Python or TypeScript library whose dependencies fit a prebuilt image. A static review room already gives NetBird a meaningful role; executing an agent-generated web server publicly adds unnecessary surface until the core is working.

### Live story

“This change breaks an order-total calculation. Watch the baseline fail, the agent repair it, and an independent run check it. Now a bad task exhausts its time budget; its sandbox is stopped while our app and this second run remain healthy. A reviewer opens the protected result, then we retire that task's URL.”

Do not force the model to make a fake initial mistake. Prepare a task with a real initial regression; the retry loop should reflect what actually happens. If the first repair succeeds, show success and use a separate honest failure fixture to demonstrate error handling.

### Feasibility gate

Before building a rich UI, get one source fixture through Vultr inference → isolated execution → error feedback → patch → independent test. If this is unstable, reduce the codebase, tool vocabulary, step count and language count. Do not add a second agent framework to compensate.

## 2. Ops Rehearsal

### User and job

An operations owner wants an agent to resolve an inventory or support issue without accidentally changing live records. The application makes a disposable task copy of synthetic operational state, tries a plan, compares before and after, then asks a human to approve the exact permitted transition.

Example: an order is delayed because a preferred vendor is out of stock. The agent examines available alternatives, updates a draft order in the rehearsal environment, discovers a policy violation, repairs the plan and produces an approval-ready change set.

### Why it could stand out

The UI can show candidate actions with computed consequences under explicit scenario rules: inventory balance, simulated delivery estimate, policy violations and records changed. Sandboxing enables bounded rehearsal. A stronger distinguishing moment is changing stock while approval is pending and correctly rejecting that now-stale approval. NetBird can create a temporary, role-gated rehearsal room per candidate.

Calling it a digital twin is justified only if we define what state and behavior it reproduces. For a hackathon, describe it as a **disposable simulation of one workflow**. Do not imply that a database copy predicts real-world vendor behavior.

### Minimal architecture

- One small order/inventory simulator implemented during the event, with synthetic data and explicit business rules.
- A deterministic transition API for the rehearsal; authoritative scoring and original state remain outside the guest's process/OS authority. Recompute the verdict from a validated action log or candidate output rather than trusting a guest report.
- For C1, the model must write/run actual code or use a real sandboxed browser on this workflow. Calling only prewritten business APIs is a clearer C2 design.
- A state diff and invariant checker outside candidate execution.
- A draft approval bound to input version, affected records, exact changes and expiration.
- A separate application endpoint applies approved changes to the demo system with version checking and an idempotency key.

Approval is a product action in the eventual application, not permission for this research agent to alter anything. For the demo, the target system remains a clearly labeled synthetic application on Vultr.

### Existing work and resources

[τ²-bench](https://github.com/sierra-research/tau2-bench) supplies policy-constrained customer-service task designs. [TheAgentCompany](https://github.com/TheAgentCompany/TheAgentCompany) models professional work across tools; its full environment involves multiple enterprise applications and substantial storage. [WorkArena](https://github.com/ServiceNow/WorkArena) supplies enterprise task ideas but current setup includes gated ServiceNow access. These are references for task structure and evaluation, not prerequisites for our event build.

### Key risk

A model-generated “simulation report” without actual state changes would be superficial. A hidden deterministic solution disguised as autonomy would also undercut the claim. Make inputs variable, allow a judge to change one constraint, and run the transition engine live. Limit to one domain, five to eight allowed actions, and a few explicit rules.

### Feasibility gate

Can a person understand the initial problem, see the proposed state changes, and tell why one plan is better within 30 seconds? Can the same input be replayed and checked deterministically? If either answer is no, narrow the business scenario.

## 3. Reconcile Room

### User and job

A finance-operations or commerce team needs to reconcile messy exports and resolve exceptions before importing the result. Upload synthetic invoices, purchase orders and receipts. The agent writes and executes a transformation, checks totals and joins, repairs an error, and produces a reconciled export with an exception queue and provenance for every changed row.

This is operational data processing, not autonomous payments or financial advice. The demo should end with a reviewed export or a write into our synthetic app.

### What makes it more than CSV chat

- Explicit input/output contract: required columns, uniqueness, decimal precision and allowed transformations.
- Conserved totals and row-level lineage; every correction points to its source record and applied rule.
- Unresolved ambiguity remains an exception instead of being silently “cleaned.”
- The result is a real file with a checksum, generated code and validation report.
- A second task cannot see the first task's uploaded data.
- A hostile instruction inside a vendor note has no authority to alter the system's policies.

Recompute invariants and lineage outside candidate execution from the original inputs and produced output. A generated `validation.json` is a claim to check, not authoritative evidence. Conserved totals alone cannot detect every incorrect record match; test identities, duplicates and unresolved alternatives as well.

### Useful resources

[DuckDB](https://duckdb.org/docs/stable/data/csv/overview) supports local tabular queries. [Pandera](https://pandera.readthedocs.io/en/stable/) offers runtime dataframe validation. [UCI Online Retail](https://archive.ics.uci.edu/dataset/352/online+retail) provides a licensed historical transaction dataset useful for realistic column patterns; it is not a source of current market facts. Team-authored synthetic fixtures remain easiest to reason about and attribute.

### Scope

Support CSV/JSON first, three source tables, one export format, one invariant suite, and one exception resolution flow. OCR, PDF extraction, bank connections, actual payment execution and accounting-system OAuth can consume the whole event. A human-readable review room with a temporary NetBird URL is sufficient for collaboration.

### Containment moment

An intentionally nonterminating transformation reaches its time limit and is destroyed. The input checksums stay unchanged, other runs remain accessible, and the team can rerun a corrected transformation. Avoid dramatic commands against real files or the host.

## Other promising wedges

### FlowFix

Turn a reported broken workflow in a team-owned web app into a reproducible Playwright test, repair the source in a code sandbox, and rerun the browser case against the patched app. Strong screenshots and a clear before/after are appealing. Avoid depending on third-party site stability; restrict to one flow. Pair visual evidence with assertions that the final state actually changed.

### Procurement Trial

Three synthetic vendor quotes or controlled supplier pages become a constrained comparison, draft purchase order and approval request. Originality comes from reconciling contradictory terms and enforcing budget/delivery constraints, not the comparison table. Use [Open Contracting Data Standard](https://standard.open-contracting.org/latest/en/) for field and lifecycle inspiration. Do not send real requests for quotation or orders in the hackathon demo.

### Support Recovery

An issue report is investigated against a synthetic service, a repair is trialed in isolation, and a human approves a narrowly scoped action. Strongest when the action restores observable service health. Multiple real SaaS integrations, authentication and ticketing permissions create avoidable risk; implement one controlled incident and one recovery action.

### Data Contract Medic

Detect a broken schema import, propose a mapping, run it against a copy, validate the output contract, then export the corrected file. A schema change plus a few misleading fields is enough to show planning and recovery. This is a narrower, easier version of Reconcile Room.

### Agent Trial Bench

Take one agent workflow and inject bounded failures: changed page label, timeout, malformed model output, hostile page text or worker death. Produce actual run evidence and automatically reproduce failures. [AgentDojo](https://agentdojo.spylab.ai/) and [DoomArena](https://github.com/ServiceNow/DoomArena) are existing reference systems. To avoid the guide's dashboard ban, make the primary user action **run, reproduce and repair a failing workflow**, with a report as the output.

## Decisions that matter more than the project name

1. **Independent verification.** The model reporting success is weaker than a deterministic assertion, observed state transition or clean test run.
2. **Bounded agency.** Give the model enough freedom to solve varied inputs while keeping operations typed, scoped and observable.
3. **One coherent risk boundary.** Explain what can fail inside the sandbox and which critical assets stay outside it.
4. **Evidence at the moment of approval.** Show exact changes and bind approval to their version; do not ask a human to approve an open-ended instruction.
5. **Lifecycle as product behavior.** Task creation, progress, cancellation, artifact retention and URL expiry should be visible and reliable.
6. **Original work.** Reuse runtimes and libraries with attribution; build the workflow, contract, evaluation and user experience during the event.

## A short validation interview before committing

Ask two nearby developers or operations people to describe the last time they distrusted an automated change. Show a 30-second sketch of the top two flows. Ask what evidence would make them approve the change, whether a downloadable artifact is enough, and which action they would never delegate. This produces more useful product direction than debating ten agent names. No interviews or messages were conducted during this research.

## Selection rule

- Pick **ProofPatch** if the team is strongest at backend/devtools and can quickly produce a small failing test fixture.
- Pick **Ops Rehearsal** if the team can build a clear business simulator and compelling state-diff UX without adding real integrations.
- Pick **Reconcile Room** if implementation time is constrained or the team is strongest in data processing.
- Pick **FlowFix** if a working, team-owned web app and Playwright experience already exist, while carefully separating pre-event code from new contributions.

All recommendations depend on a short infrastructure smoke test. The exact runtime and model should be chosen after checking current Vultr access, capability and latency; see the platform and sandbox memos.
