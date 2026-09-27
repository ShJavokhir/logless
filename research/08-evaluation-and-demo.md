# Evaluation, demo and submission playbook

Proposed plan, September 26, 2026. No application, benchmark, containment test or demo recording was produced during this research. Use the selected workflow's real results to fill in the evidence below.

## The core claim to demonstrate

“A user gives the agent a real task. It executes on Vultr within a defined boundary, recovers or stops safely when something goes wrong, and returns an artifact or changed state that we can independently check.”

For ProofPatch/blocked-import repair, make the checked outcome concrete: the original adapter rejects the input; the generated repair transforms it; the trusted checker confirms specified identities/invariants; the user receives a patch, export and evidence. Any displayed counts must be computed from the actual run.

The UI should make four questions answerable at a glance: what was requested, what is running, what actually changed, and why the result should be accepted. A timeline supports the product; the repaired artifact or completed operation is the main feature.

## Minimum acceptance evidence

This is an implementation checklist, not a claim that the checks passed. The larger sandbox memo supplies additional tests. Prioritize the boundary claims the demo will actually make.

| Test | Observable result | Avoid a weak substitute |
|---|---|---|
| Real successful task | Generated code/browser actions, observed execution, downloadable output | Model-only summary |
| Recovery | Actual failure observation leads to a bounded repair attempt | Fabricated error or replay presented as live |
| Checker independence | A plausible wrong output fails a check outside candidate control | Agent-created `tests_passed: true` |
| Timeout | External supervisor stops task and descendants | UI spinner stops but process continues |
| Host/run separation | Known host marker unchanged; another run remains isolated | Sandbox hostname alone |
| Secret absence | A synthetic control-plane canary is absent from guest/env/output | Searching only the generated code text |
| Cleanup | Runtime reports environment gone; repeat run starts clean | Request handler exits without inspecting resources |
| Artifact safety | Traversal/symlink/active-content fixture rejected or safely isolated | Trusting extension or guest-supplied MIME type |
| Authorization | Another task/user's artifacts denied; irreversible action rejected without exact approval | Hiding a button |
| Public route | Fresh external browser completes the flow | Localhost works |
| NetBird lifecycle, if claimed | Session service removed and new request fails; stable judge entrance still works | Backend stopped, old route remains provisioned |
| Inference routing | All runtime model requests go through Vultr; no silent library fallback | Only the first planning request uses Vultr |

Use synthetic fixtures and team-owned destinations. No real escape exploits, uncontrolled fork bombs, host deletion or third-party attacks are needed. A bounded busy loop, intentionally oversized allocation or guest-scratch deletion can show the relevant limit once safely configured.

## Small fixture suite

| Case | Suggested input | Expected product behavior |
|---|---|---|
| Happy path | One valid import with known expected records | Completes, exports correct output |
| Mapping regression | Source field renamed in a disclosed new-format fixture | Agent repairs adapter and reruns |
| Duplicate identity | Two records share an order ID | Reject or handle per explicit contract; no double import |
| Ambiguous reference | Two possible product matches | Preserve exception and request a narrow choice |
| Arithmetic edge | Fractional quantity, negative return or rounding boundary | Follow explicit domain rule; no guessed correction |
| Malformed tool output | Wrong JSON type or oversized field | Validation error and bounded retry/failure |
| Resource failure | Intentionally nonterminating task code | Deadline enforced, app stays responsive |
| Hostile note | Instruction embedded in input comments to alter policy | Treat as data; proposed unauthorized action denied |
| Stale approval | Source/state version changes after preview | Old approval rejected; new preview needed |
| Cancellation/restart | Cancel mid-run or restart the worker on a disposable test | Durable status and cleanup reconciliation |

Fixtures must not all be the same example with cosmetic variations. Preserve at least one held-out case from the generator. For browser projects, replace table cases with a button-label change, delayed element, redirect and a no-submit-before-approval check on the team's controlled site.

Report the number of cases and repeats, exact commit/model/image versions, and failures as well as successes. A ten-case suite is useful engineering evidence, not a broad accuracy or security guarantee. Do not compare it numerically to SWE-bench or WebArena.

## Metrics worth retaining

- Completed task / attempted task count under the named contract.
- Valid action arguments / requested actions and bounded retry counts.
- Model latency, execution time, collection time and cleanup time separately.
- Token usage and estimated inference cost using the saved catalog's units.
- Peak observed memory and whether cancellation killed descendants.
- Time from review-session closure to confirmed route removal.
- Artifact hashes and immutable contract/input versions.

Avoid a large metrics dashboard unless it helps explain the live task. Put detailed evidence in a downloadable manifest or developer view. If reporting a latency percentile from a tiny sample, state sample size and avoid implying production performance.

## One-minute submission video

The supplied participant guide requests a one-minute video. Exact form limits are unverified because the portal requires login. Target 55–60 seconds until organizers clarify.

| Time | Screen/action | Narrative purpose |
|---|---|---|
| 0–5 s | Concrete failed task and intended outcome | Explain why a user cares |
| 5–18 s | Agent plan → actual isolated execution → real result | Establish agentic work on Vultr |
| 18–30 s | Patch/export/state diff and externally computed checks | Establish verifiable output and new contribution |
| 30–40 s | One bounded containment fixture, killed task, healthy app | Required C1 containment moment |
| 40–55 s | Workload firewall → NetBird auth/result → closed session URL | Show optional bonus in a compact sequence |
| 55–60 s | Final artifact, project URL and one-sentence potential | Leave a clear product outcome |

If pursuing fewer bonus capabilities, use the extra time to clarify the main work. If inference exceeds the available footage, label time compression or show a recorded real run; do not label edited footage as uninterrupted live execution. Make the live judging flow separately reliable. Never reveal sponsor keys, setup tokens, venue credentials, admin credentials or private data while switching screens.

## Three-minute live demonstration

| Time | What happens |
|---|---|
| 0:00–0:20 | State the user's problem and show initial failing behavior |
| 0:20–1:15 | Submit a real task; narrate the agent's executed steps and actual feedback |
| 1:15–1:45 | Inspect generated patch/output and checker result; vary one meaningful input if stable |
| 1:45–2:10 | Run one bounded containment test and show recovery/cleanup |
| 2:10–2:40 | Open protected review URL; close its session; stable app remains accessible |
| 2:40–3:00 | Show compact architecture and explain what the team built and what comes next |

For Ops Rehearsal, swap some checker time for the state-version race: edit stock while approval is pending, reject stale approval, then rerun. Do not attempt every safety test on stage. Have one known small task ready, but let the computation happen live.

## Failure fallback that preserves honesty

- If a model request fails, show the real error and retry with a pretested second Vultr model. Keep provider identity visible for Track 1.
- If the agent cannot solve the task, show the partial output and precise failed check. A bounded honest failure is better than a false green badge.
- If network or inference is unavailable, show a clearly labeled previous run with its timestamp/manifest plus the running deployment; never imply the replay is live.
- Keep the stable judge URL independent of temporary sessions, laptop terminals and the lifecycle fixture.
- Freeze images/dependencies before recording. Keep the last working deployment/config available for rollback.

## Short answers for likely judge questions

| Question | Evidence-based answer to prepare |
|---|---|
| What did you build here? | Name workflow, acceptance contract, control-plane code, UI, verifier and lifecycle integrations; credit runtime/library components |
| Why use a sandbox? | Point to the demonstrated host/data/resource boundary and the useful task it makes possible |
| What runs on Vultr? | Actual VM roles, persistence, sandbox execution and inference routing |
| Is Docker alone secure? | State the actual runtime, kernel/VM boundary, mount/network policy and residual trust; avoid universal claims |
| How do you know the result is correct? | External contract checks plus preserved input/candidate identity; state what is untested |
| Could the agent fake the tests? | Explain the external checker and bounded I/O, or honestly label general-repo tests a clean rerun |
| Can prompt injection bypass approval? | Show enforcement outside the model/guest and at the action target, not just a system prompt |
| What if the worker dies? | Persisted task state, TTL and cleanup reconciliation; distinguish implemented recovery from roadmap |
| Are there really no ports open? | Identify the workload VM's closed public application ports and the separate publicly reachable NetBird edge |
| What expires? | The task/review session URL and its service; durable artifacts remain separately authorized |
| How does it scale? | Current measured concurrency, then additional isolated workers; label this as a scaling plan |
| How much does it cost? | Observed run token/compute usage and exact catalog rates; distinguish it from a forecast |
| Why is this different from existing agents? | The specific acceptance/approval decision enabled by our workflow; do not claim sandboxing itself is novel |

## Repository and submission materials

Suggested README contents:

1. One-sentence product description and the problem solved.
2. Public demo URL and limited judging role instructions.
3. A short video link and clear note of work built during this event.
4. Architecture diagram with public/control/guest boundaries and Vultr services.
5. Exact local/deployment setup, pinned dependencies and placeholder-only environment example.
6. One command or UI flow to reproduce the normal fixture and one containment fixture.
7. Evidence from actual checks, with failures and limitations.
8. Dependency/data credits and licenses.
9. Cleanup instructions and retention plan for judging.

Prepare `BUILT_DURING_HACKATHON.md`, a sanitized `demo-evidence/` directory and a small fixture readme. These are our recommended organization, not extra organizer-mandated filenames. The submission portal's authenticated field set still needs to be checked by the team. The guide's deadline is Sunday, September 27 at noon PDT; leave an upload/permission-check buffer.

