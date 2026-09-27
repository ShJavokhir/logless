# logless — MVP implementation specification

**Purpose:** Build a complete, demonstrable product, not a mock dashboard.  
**Release:** Vultr hackathon proof of concept; synthetic data only.  
**Demo budget:** Three minutes live and one minute recorded.  
**Companion:** [Project brief](./logless-project-brief.md).

This document defines the implementation scope. Numeric limits and stack choices are practical MVP defaults, not benchmark claims. Preserve the product and containment requirements when adapting defaults to an existing repository. References explain the influences; they do not add features to this specification.

## 1. Product contract

logless helps personal-assistant product teams understand their users without opening private conversations. It answers two questions:

> What are people doing with our assistant?
>
> What are they trying to do that isn't working?

The core loop is **conversations → private facets → discovered themes → classified interactions → generalized cluster hierarchy → representative fictional user story**.

The product reveals unexpected workflows and observable friction. It does not infer a universal success score, provide employee access to individual records, or simulate customers using another product.

The target user is a PM at a personal-assistant company. The demo workspace is **Muse · Synthetic demo**. Muse is an illustrative workspace name, not a claim of affiliation, access to Meta's data, or findings about a real service.

A successful presentation shows an understandable workflow the team might not have anticipated, evidence of repeated friction within it, and a fictional story that makes the underlying need concrete.

## 2. Scope and non-negotiables

| Ship in this MVP | Explicitly out of scope |
| --- | --- |
| One bundled synthetic dataset and one published analysis snapshot | Uploads, connectors, real customer data, multiple workspaces |
| Model-discovered themes and a two-level hierarchy | Embedding infrastructure, vector databases, open-ended clustering research |
| Usage counts and three observable friction signals | Universal success scores, sentiment dashboards, causal diagnosis |
| Visual exploration and Jev semantic highlighting | Arbitrary questions over private records, custom cohorts, date filters |
| Two fixed PM analysis questions with real sandbox execution | A general-purpose code agent or conversational analytics thread |
| One grounded fictional story per selected cluster | Persona libraries, customer replay, product simulations |
| Visible run status and one containment demonstration | A separate agent-management product or infrastructure dashboard |

Vultr hosts the web app and VM-based control plane. GLM 5.3 reasoning calls use Vultr Serverless Inference. Jev calls use TypeSafe's API under the exception confirmed by the project team. All generated analysis code runs in disposable sandboxes on Vultr, outside the application process. Provider credentials stay outside those sandboxes.

The challenge requires actual executed output, bounded execution, and a visible containment moment. A privacy refusal, animation, or model-written explanation alone does not meet that requirement. See the supplied *CV Hackathon Challenge 1 — Agent Sandboxing*, pages 1–4, especially execution Pattern A and the video requirements.

## 3. Synthetic dataset

### Composition

Bundle approximately **600 conversations from 150 fictional users over one fixed 28-day period**. The manifest records the actual counts and dates. The UI uses manifest and computed values, never these suggested numbers as constants.

Conversations cover ordinary personal-assistant work: finding information, drafting messages, organizing schedules, following up, travel administration, and coordinating responsibilities with other people. Include several cross-cutting workflows so the analysis reveals goals beyond tool categories such as “email.”

Seed at least one discoverable workflow involving coordination across people, changing constraints, and follow-up. Distribute it across multiple fictional users and linguistic variations. Include both smooth interactions and observable friction within that workflow. Its exact published name is an analysis result, not a prescribed label.

Include explicit corrections, task-related complaints, unresolved action errors, recovered action errors, ambiguous endings, and conversations without negative feedback. Include a small number of rare scenarios, distinctive invented identifiers, and instruction-like text to exercise generalization and prompt-injection handling. Do not make every interaction problematic.

### Records and provenance

A source conversation contains a private conversation ID, fictional user ID, timestamp, ordered messages, and optional structured tool events. Tool events identify the attempted action, result, and subsequent resolution when observable. Do not infer a successful action from an assistant's assertion alone.

Generate the dataset before the presentation, using authored scenario templates and/or GLM through Vultr. Commit the resulting synthetic fixture, a reproducible generation recipe, and a manifest. Reproduction means the committed dataset and its pipeline inputs are reproducible; model outputs need not be bit-for-bit deterministic.

Keep generator labels and expected patterns in a separate evaluation fixture. The discovery and classification inputs must not contain those labels, scenario titles, target friction flags, or the intended demo conclusion.

Synthetic source fixtures may be included in the open-source repository. They must not be exposed through the analyst web application's routes, static assets, or browser payloads. Their publication as explicitly fictional test data does not constitute a privacy guarantee for future real data.

## 4. Product experience

### One explorer, not a collection of dashboards

The initial page opens a completed snapshot immediately. Its header contains the logless wordmark, workspace name, synthetic-data badge, fixed observation period, and actual conversation count. Display “Aggregate insights only” with a short explanation of the access boundary.

The main canvas contains a stable, two-level **packed-circle usage map**. Broad categories contain workflow clusters. Leaf-circle area reflects conversation count; spatial proximity has no claimed semantic meaning. Show a compact legend. Use a standard layout library rather than implementing a visualization engine.

A compact hierarchical list mirrors the same clusters for navigation, small labels, and keyboard access. It is not a separate analytics view. Selecting a parent focuses its children; selecting a leaf opens its detail panel. Breadcrumbs restore the previous level. No dot or list item represents a person or conversation.

### Two practical questions

Prominent question controls read **“What are people doing?”** and **“What's not working?”**. The initial usage view is already populated from the published snapshot. Activating either question runs the bounded analysis described in Section 7 and updates a short answer panel and cluster ranking.

The friction view retains circle sizes and positions while emphasizing observed-friction share. It also orders the accompanying list by the number of conversations with observed friction. Display the denominator and share alongside the count; do not rank only by percentages that favor tiny clusters.

During a run, keep the existing map usable. Show brief status labels such as “Preparing analysis,” “Running in sandbox,” and “Checking results.” Place technical details in a collapsed “Run details” drawer, not in the primary workflow.

### Semantic exploration

A field labeled **“Find a workflow…”** accepts concepts such as “coordinating with other people.” Jev highlights relevant published clusters and their parent categories. Dim nonmatches without resizing circles or recalculating usage statistics. Clearing the field restores the map.

Debounce requests by approximately 300 milliseconds, ignore superseded responses, and keep selection stable. Display “No matching published insights” when appropriate. A query asking for private records never gains access to another data source.

Semantic matching selects clusters, not individual interactions. Do not display a new “percentage of users matching your question.” Cluster counts remain those of the published snapshot.

### Cluster details and story

The detail panel contains the cluster title, plain-language description of the workflow, conversation count and share, observed-friction count and share, the three signal breakdowns, and concise generalized descriptions of the needs and problems. It also contains **“Generate user story.”**

The story appears in that panel with a prominent fictional label. No avatar generation, demographic dossier, testimonial quotation, transcript-style conversation, or separate persona page is required.

### Visual direction

Use a light, calm, high-contrast interface with ample whitespace and restrained category colors. Typography, labels, and evidence must remain readable in a screen recording. Prioritize a laptop viewport around 1440 × 900; narrower screens stack the details below the explorer. Avoid decorative 3D scenes, constantly moving particles, console-first styling, and a full design-system project.

Use short transitions to preserve spatial context. Honor reduced-motion settings, provide visible keyboard focus, and never rely on color alone to convey friction or selection.

## 5. Private discovery pipeline

This pipeline runs before the presentation. It is a real executable workflow, not a set of manually prepared UI fixtures. One operator command rebuilds a candidate snapshot from the bundled source data.

### 5.1 Validate and extract facets

Validate records and unique IDs. Derive simple metadata such as turn count in code. GLM extracts a structured description of the user's goal, requested task, relevant action sequence, and evidence potentially indicating correction, complaint, or an unresolved action error.

Summaries preserve the task and relevant sequence while generalizing names, contact details, organizations, exact locations, exact dates, and distinctive circumstances. Source records and per-conversation facets remain private even after generalization. The browser never receives them.

Extraction preserves uncertainty. Distinguish a user changing their preference from correcting an assistant mistake, a complaint about life from a complaint about the assistant, and a recovered tool error from an unresolved one.

### 5.2 Discover themes with GLM

Ask GLM to propose workflow themes from the private facets. Cover the entire fixture, using bounded batches followed by consolidation when necessary. Do not derive the taxonomy from the first few records alone.

Target roughly 10–15 coherent leaf workflows under 3–5 broad categories, without forcing an exact number or erasing a distinctive need merely to hit a target. Name themes by the user's goal rather than the tool used. Include an “Other or unclear” assignment destination.

The model returns descriptions and membership criteria. Stable IDs are assigned and validated by code. This MVP uses model-guided theme discovery followed by classification; it does not reproduce Clio's embedding-and-k-means implementation.

### 5.3 Classify with Jev

For each abstracted interaction, use Jev to select one primary leaf theme and independently classify each of the three friction signals. Batch these questions against the same input rather than making a sequential model call for every attribute.

Each friction decision is **observed**, **not observed**, or **unclear**. Theme membership is exclusive for count arithmetic; friction signals may overlap. Records that do not fit remain in “Other or unclear,” without being dropped from totals.

Use TypeSafe's typed Choice questions for these decisions. Start with a conservative, configurable confidence cutoff of 0.65; lower-confidence choices become unclear. This cutoff is an implementation heuristic to validate against synthetic fixtures, not calibrated statistical certainty. Store the returned model identifier and question-version identifiers privately. See the [API reference](https://docs.typesafe.ai/api) and [parallel-question cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions).

### 5.4 Generalize, describe, and organize

GLM describes each assigned cluster using its private facets. Produce a short workflow description, generalized user needs, and task-related friction descriptions. Attach internal supporting record references to claims for automated validation, but never include those references in published output.

A description of a particular gripe must be supported by the corresponding records, not merely by a cluster-level complaint count. Do not invent a specific technical root cause, product limitation, or causal explanation.

Organize leaves under broad parents. Validate a cycle-free hierarchy with exactly one parent per leaf. Generalize unsafe or overly specific wording, and roll a finding into a broader meaningful cluster when necessary. Apply the publication rules in Section 10 before releasing any text.

### 5.5 Compute, check, and publish

Compute all counts and ratios in an isolated sandbox using a version-controlled aggregation task. The aggregation task receives typed assignments and private grouping identifiers, not raw transcript text. It returns approved-shape aggregates only.

Reconcile all records and validate arithmetic independently. Apply text checks to cluster titles, descriptions, needs, and friction explanations. Publish the complete snapshot atomically only after validation; leave the last good snapshot active when a rebuild fails.

Persist the dataset hash, pipeline version, model identifiers, prompt versions, run timestamps, and validation result. Preserve genuine precomputed outputs for fast loading and reproducible demonstration. Do not hardcode a preferred insight or adjust measured counts to improve the story.

## 6. Model responsibilities and semantic matching

**GLM 5.3** handles facet extraction, theme discovery, cluster description, bounded analysis planning and code generation, result explanation, and grounded story writing.

**Jev** handles narrow classification decisions and live relevance judgments. It does not invent the taxonomy, write stories, calculate statistics, or certify privacy.

For semantic exploration, send only the query and approved cluster summaries to Jev. Evaluate relevance independently for each leaf in parallel so multiple clusters can match. A relevant/not-relevant/unclear Choice question per leaf is sufficient. Include the cluster text in the question or shared state explicitly; do not assume API question IDs convey meaning to the model. Highlight only supported matches, and allow no matches.

Keep classification rubrics and relevance rubrics separate. Relevance scores and model confidence are internal routing signals, not percentages of user behavior or certainty that an insight is true. TypeSafe describes confidence as derived from its answer distribution; logless must not turn that into a privacy or accuracy promise. See [Confidence](https://docs.typesafe.ai/confidence).

The runtime uses these two providers only. Coding agents may use their own development models; that does not authorize substituting a different production inference provider.

## 7. Live sandboxed analysis

The public analysis interface accepts exactly two intents: **usage** and **friction**. Natural-language search is separate and does not become arbitrary code-generation input.

For either intent, GLM receives the fixed task, the approved snapshot schema, and the available aggregate evidence. It writes a small Python analysis program. The trusted control plane dispatches that program into a disposable container with a read-only aggregate snapshot and an empty output directory.

The usage task ranks published leaf workflows by conversation count and returns the relevant counts and shares. The friction task ranks the same workflows by observed-friction conversation count and returns the signal breakdowns and denominators. Neither task opens private records, creates new cohorts, or estimates statistics.

A successful run produces a schema-validated result artifact containing the intent, snapshot ID, ordered cluster IDs, and computed metrics. The UI renders a compact ranked chart or list from this artifact. Chart labels come from approved snapshot text, not arbitrary executable output.

The backend independently checks metric values and ordering against the published snapshot. Invalid output or execution errors may be sent to GLM for **one correction attempt** in a fresh sandbox. After validation, GLM writes a short explanation grounded in the returned evidence. Require references to published cluster or metric IDs; insert exact displayed numbers from validated values rather than trusting model-written arithmetic.

The fixed state sequence is planning, executing, validating, optional retry, explaining, and completed or failed. This is the main agent execution loop. It does not require an agent framework, planner swarm, or user-facing “analyze this pattern” workflow.

The run drawer shows actual timestamps, model identifiers, executed-program hash, sandbox outcome, retry count, and a link to the safe aggregate result. A successful model response without a successful execution receipt must never appear as a completed analysis.

Precomputed answers can load with the snapshot. Label them as precomputed. A question control initiates a fresh run; repeated clicks while it is running return the same job. A live demonstration must include at least one real successful generated-code run, in addition to the containment test.

## 8. Representative fictional user story

Story generation receives only the selected cluster's **published** title, summary, needs, friction descriptions, metrics, and stable evidence IDs. It has no retrieval tool or access to source records, private facets, fictional source-user profiles, or unrelated cluster data.

GLM returns an invented first name, minimal setting, what the person wants to accomplish, and the supported frustrations. Target 90–140 words total. Needs and gripes must reference published evidence IDs. The name and minimal connective scene-setting are fictional; occupations, diagnoses, precise locations, ages, or family histories are not added for dramatic effect.

Display this label above every story:

> Fictional user story. Illustrates an aggregate pattern; not a real customer or additional evidence.

Where the cluster has no supported gripes, state that no specific frustration is established instead of inventing one. Describe an illustrative situation without suggesting that every person in the cluster shares the entire story.

Validate schema, evidence references, unsupported specifics, and seeded identifying canaries before display. Allow one repair attempt, then show an error with retry. Do not stream unvalidated story text to the browser.

Cache one validated story per snapshot and cluster. Label an existing story as previously generated. No story gallery, editing tools, export flow, or repeated persona variations are required. Stories never feed back into counts, discovery, or evidence.

## 9. Metric definitions

The unit of usage is a **conversation**, not a message, user, or model call. State this in the UI.

| Metric | Definition |
| --- | --- |
| Conversation count | Number of conversations assigned to the cluster or any descendant leaf |
| Usage share | Cluster conversation count divided by all conversations in the published snapshot |
| Unique users | Distinct fictional user IDs in that cluster; calculate privately, publish counts only |
| Correction count | Conversations with observed assistant-related corrections |
| Complaint count | Conversations with observed task-related complaints about the assistant |
| Unresolved action-error count | Conversations with an observed failed action not shown to recover within that conversation |
| Observed-friction count | Distinct conversations with at least one observed friction signal |
| Observed-friction share | Observed-friction count divided by the cluster's conversation count |
| Unclear assessment count | Conversations with no observed signal and at least one unclear friction decision |

“Not observed” means no qualifying evidence was detected, not that the interaction succeeded. Conversations with observed friction and another unclear signal still count once in observed friction. No-observed-friction and unclear-assessment counts are not success counts.

Parent conversation and friction counts use unions of descendant records. Parent unique-user counts must not be summed from children because a user can appear in multiple workflows. Signal counts overlap and must not be summed to obtain overall friction. Leaf counts, including “Other or unclear,” reconcile to the snapshot total.

Store exact integer counts; round percentages consistently to one decimal place for display. Zero denominators produce an unavailable value, not NaN or an invented zero. Do not publish an incomplete pipeline run as if it covered the complete fixture.

The MVP has one fixed observation period. Trend charts, growth claims, language breakdowns, and arbitrary time comparisons are future work.

## 10. Privacy, signal preservation, and publication

### Access boundary

Private processing includes source messages, user and conversation IDs, per-conversation facets, assignments, internal evidence references, intermediate descriptions, and private diagnostic content. Only approved aggregate snapshots, validated public analysis artifacts, and validated fictional stories cross into the analyst interface.

Enforce this boundary in API schemas and file permissions, not just by hiding UI controls. Public output is assembled from an explicit allowlist. Do not serialize private objects and delete a few known fields afterward. No raw-record routes, trace viewers, private CSV downloads, public source maps containing fixtures, or private stdout in run details are permitted.

GLM and Jev processing is within the trusted automated processing boundary. Infrastructure operators and inference providers are not made blind to the data. Model prompts, completions, and request bodies are not written to ordinary application logs. Log operational metadata and sanitized error codes. The name “logless” is not a claim that the application stores no data or operational logs.

### Preserve rare signals without inventing prevalence

Do not impose a blanket minimum-cluster-size suppression rule in this prototype. Preserve an unusual product need by removing distinctive circumstances, rewriting it at a broader level, or combining it with a semantically appropriate parent.

Generalization changes the description, not the observations. A rare gripe incorporated into a broader workflow must not acquire the parent's full count. Use language such as “an observed request” rather than “a common need” when support is limited. Never multiply source records, duplicate assignments, or fabricate supporting users to make a finding appear common.

When a distinctive detail fails publication checks, rewrite or generalize it before publication. If a safe specific description cannot be established, retain its counts and underlying task at a broader level; do not release the identifying wording. A failed candidate snapshot leaves the previous snapshot intact rather than bypassing the checks.

### Checks and honest limits

Check all published text for seeded canary strings, direct contact details, source-record IDs, distinctive source phrases, and unnecessarily specific combinations of details. Use deterministic checks plus a bounded GLM generalization/audit pass. Treat fixture content as untrusted data, including instructions embedded inside conversations.

Use the same publication boundary for labels, tooltips, generated explanations, search results, downloadable artifacts, and stories. Search and live analysis cannot traverse back from a cluster ID to a private conversation.

The product is **synthetic-only and not production-validated for private customer data**. Generalization, audits, and access controls do not establish differential privacy or eliminate re-identification risk. In particular, this prototype deliberately differs from Clio's use of aggregation thresholds and must not claim equivalent protection. See the [paper, privacy design](https://arxiv.org/html/2412.13678v1).

## 11. Minimal architecture

Use one Vultr VM with a web frontend, one trusted API/control-plane service, local persistence, and disposable Docker execution containers. Serve the public application through HTTPS. Keep management endpoints and the container daemon private.

Use the repository's existing suitable stack. For an empty repository, default to **React and TypeScript with Vite for the frontend; a Python FastAPI backend; SQLite for jobs and snapshot metadata; local JSON artifacts; Docker for execution**. A small reverse proxy serves the static frontend and API under one origin. These defaults are not a requirement to replace a working equivalent stack.

The backend owns provider calls, pipeline coordination, job status, output validation, and sandbox lifecycle. A narrowly scoped runner module may contact the local container daemon; user input and generated programs cannot select container options, arbitrary commands, host mounts, or network policy.

Trusted orchestration runs on the VM. Generated programs run only inside execution containers. Remote model inference runs at Vultr and TypeSafe, not inside those containers. No extra credential broker or model server is required because sandbox programs have no provider access.

Use a bounded background task queue inside the backend and persist job states in SQLite. A server restart marks interrupted jobs as failed and cleans up tagged orphan containers. One-second status polling is sufficient; WebSockets, Redis, Celery, Kubernetes, managed databases, and object storage are unnecessary for this demo.

## 12. Data contracts and API surface

Use explicit validated schemas. Stable IDs link data; no browser-facing contract contains source-user or source-conversation identifiers.

| Entity | Required content | Visibility |
| --- | --- | --- |
| Dataset manifest | Version, synthetic marker, period, actual record counts, source hash | Safe subset public |
| Conversation and facet | Source fields and abstracted per-interaction evidence | Private |
| Taxonomy and assignment | Theme definitions, primary membership, tri-state signals, internal support | Private until publication |
| Published snapshot | Snapshot ID, provenance summary, totals, period, hierarchy, approved clusters | Public demo |
| Published cluster | ID, parent, title, summary, generalized needs/gripes, counts, ratios, safe evidence IDs | Public demo |
| Run | ID, kind (analysis, story, or containment), intent when relevant, snapshot, state, timestamps, attempt count, validation status, safe result reference | Sanitized subset public |
| Story | ID, snapshot and cluster IDs, fictional label, validated fields, evidence IDs, generation time | Public demo |

Each safe evidence ID identifies an approved claim or metric, not an individual or a route to private evidence. Published text and metrics carry the same snapshot ID. Reject cross-snapshot references.

Provide a compact public API:

| Endpoint | Contract |
| --- | --- |
| `GET /api/snapshot` | Return the current complete published snapshot; no rebuild on page load |
| `POST /api/search` | Accept query and snapshot ID; return matching approved cluster IDs and measured elapsed time |
| `POST /api/analyses` | Accept only usage or friction and snapshot ID; return an asynchronous run ID |
| `GET /api/runs/{id}` | Return sanitized status, result, and execution receipt; never raw private diagnostics |
| `POST /api/clusters/{id}/story` | Accept snapshot ID; return a cached validated story or generation run ID |
| `POST /api/demo/containment` | Launch only the fixed resource-limit fixture; no supplied code or command |
| `GET /api/health` | Report service readiness without environment values or secret configuration |

An operator command, not a public import or admin screen, generates seed data and rebuilds snapshots. Keep public requests bounded in size, concurrency, rate, and model expenditure. Containment requests require no model call and have their own small rate limit. No user-account system is needed for an explicitly public synthetic demo.

## 13. Sandbox contract and containment demonstration

Every generated-code run uses a fresh, prebuilt Python execution image. Baseline aggregation uses the same runner. Do not install packages, build images, or access the internet inside a job.

Run as a non-root user with a read-only root filesystem, dropped Linux capabilities, no privilege escalation, the default security profile, no network, no provider keys, and no container-daemon socket. Mount only the task's read-only input and its empty task-specific output. Never mount the application directory, home directory, credential files, or an entire host data directory.

Default task limits are one CPU, 512 MiB memory, 64 processes, a bounded temporary filesystem, and ten seconds of execution wall time. Limit captured output and result artifacts to 1 MiB each. Provider waiting time is separate from execution wall time. Configure a small global concurrency limit so the application remains responsive.

The trusted runner enforces wall-clock deadlines externally, terminates the whole container, verifies exit status, and destroys the environment after success, failure, or timeout. Validate output filenames, types, sizes, and schemas; do not follow output symlinks or execute generated HTML. Pre-created input/output locations must have explicit ownership suitable for the non-root execution user.

For the visible containment moment, run a **fixed infinite-loop fixture with a two-second deadline** in an otherwise empty sandbox. The backend records that the container was terminated and removed. The UI displays “Execution limit reached · sandbox terminated,” the actual elapsed time, and an application health result. Follow it with a successful normal run or health check.

Do not use destructive host commands, real secrets, or a fake timeout animation. The fixture demonstrates resource containment, not proof against every possible container escape. Docker's [run controls](https://docs.docker.com/engine/containers/run/), [resource limits](https://docs.docker.com/engine/containers/resource_constraints/), and [security guidance](https://docs.docker.com/engine/security/) are implementation references.

## 14. Provider integration and configuration

Use GLM model ID **`glm-5.3`** through the OpenAI-compatible base URL **`https://api.vultrinference.com/v1`**. The model appears in Vultr's [live catalog](https://api.vultrinference.com/v1/models) checked on September 26, 2026. Verify account access and supported parameters with a small request before implementing provider-specific features. Do not assume every OpenAI API feature is supported because the endpoint is compatible.

Use Jev's **`https://api.typesafe.ai/v1/systemone`** endpoint. Begin with the documented **`jev-latest`** alias and record the actual model returned; pin a verified supported version for the demo when available. Use `state` plus typed `questions`, not a chat-completion payload. See the [quick start](https://docs.typesafe.ai/introduction/quickstart).

Define environment configuration for the Vultr API key, Vultr base URL and model ID, TypeSafe API key and model ID, public origin, persistence directory, execution image, and resource limits. Keep secrets on the backend only. Supply an environment-example file containing names and placeholders, never real credentials.

Validate structured model outputs locally. Bound transport retries and structured-output repair separately so their combination cannot create an unlimited loop. Retry transient throttling with capped backoff; expose authentication or unsupported-model errors as configuration failures. Never silently switch to another provider or return test fixtures as live inference.

## 15. State, failure handling, and performance

A job is queued, running, completed, failed, or timed out; its stage provides more detail. Story jobs do not claim sandbox execution when they only call a model. The run UI distinguishes discovery provenance, generated-code execution, semantic classification, and story generation.

Persist successful snapshots and validated stories. Deduplicate identical in-flight requests. A new snapshot invalidates old search and story cache keys. Browser responses apply only to the currently requested snapshot and request ID.

Missing credentials leave any genuine saved snapshot browsable and show which live capabilities are unavailable. Failed search leaves ordinary browsing available; failed analysis retains the last result with its original timestamp. Never substitute invented metrics or simulated success. Test doubles stay confined to tests or an unmistakably labeled development mode.

Performance targets, to be measured on the deployed VM, are: initial saved-snapshot load within two seconds; local selection feedback effectively immediate; semantic matches around one to two seconds after debounce; a live analysis within 25 seconds; and a validated story within 12 seconds. These are demo targets, not provider guarantees. Full discovery runs before the presentation and has no live-demo latency requirement.

When targets are missed, reduce prompt size, output length, concurrency, or redundant calls before adding infrastructure. Display measured timings, not marketing estimates.

## 16. Acceptance criteria and verification

The implementation is complete when the following checks pass. Use focused unit/integration tests for data and containment, plus one browser walkthrough; do not build a generic evaluation platform.

| Check | Required evidence |
| --- | --- |
| Real pipeline | A rebuild from the source fixture produces a new validated snapshot with provider and pipeline provenance |
| No answer leakage | Generator labels and expected findings are absent from discovery/classification requests |
| Useful discovery | The resulting hierarchy contains an identifiable cross-cutting workflow and grounded recurring friction; evaluation checks meaning rather than exact label wording |
| Metric reconciliation | Every conversation has one primary assignment; leaf totals reconcile; friction unions and parent distinct-user counts are correct |
| Honest uncertainty | Silent endings, ambiguous evidence, preference changes, and recovered tool errors are not automatically counted as failures |
| Publication boundary | Public API responses, rendered HTML, assets, tooltips, errors, and artifacts contain no source IDs, private facets, or seeded identifying canaries |
| Rare-signal preservation | A rare fixture's generalized task survives publication or roll-up, without its identifying detail or inflated prevalence |
| Real Jev behavior | Live provider calls classify facets and highlight published clusters; an unrelated query can produce no matches |
| Real agent work | A GLM-generated program executes in a disposable container and produces validated usage or friction results |
| Result integrity | Fabricated cluster IDs, incorrect counts, invalid ordering, and cross-snapshot references fail validation |
| Bounded recovery | A controlled execution error receives at most one code-repair attempt; a second failure is shown honestly |
| Grounded story | The generator receives only public evidence, uses valid evidence IDs, invents no unsupported gripes, and displays the fictional label |
| Containment | The infinite loop is stopped by the runner, the container is removed, and the application remains healthy; sandbox access to network and secrets is blocked |
| Deployable experience | A public HTTPS URL on Vultr supports the complete flow without a developer terminal or manual response editing |

Run the normal build, frontend type checks, and relevant tests, then inspect the deployed UI at the target laptop viewport. Verify label legibility, loading/error states, keyboard selection, stale-request handling, and that every visible control works. Distinguish checks actually executed from those blocked by missing credentials or deployment access.

## 17. Demo sequence and deliverables

### Three-minute live demo

| Time | Action and message |
| --- | --- |
| 0:00–0:20 | Introduce the problem: understand assistant usage without reading conversations. Establish that the workspace is synthetic. |
| 0:20–0:45 | Explore the completed usage map and open an unexpected workflow. The discovery snapshot is labeled precomputed. |
| 0:45–1:05 | Type a meaningful concept; Jev highlights relevant clusters without exposing records. |
| 1:05–1:45 | Ask “What's not working?” Show a real generated-code sandbox run, its computed ranking, and the observed friction. |
| 1:45–2:20 | Generate a fictional user story from the chosen finding. Point out the needs, gripes, and evidence boundary. |
| 2:20–2:40 | Open the compact demo drawer and run the contained infinite loop. Show termination and application health. |
| 2:40–3:00 | Close on the product decision the evidence informs. Briefly identify Vultr, GLM, and Jev's distinct roles. |

The one-minute recording uses the same storyline with shorter narration and edited waiting periods. Preserve real outcomes, provenance labels, and the containment moment. Do not accelerate a timing display or present precomputed inference as live performance.

### Repository and handoff

Deliver the frontend and backend, synthetic fixture and generation recipe, pipeline entrypoint, validated snapshot, model adapters, sandbox image and runner, focused tests, deployment configuration, environment-example file, and open-source license. Include the public URL, one-minute video, and the three-minute walkthrough above in the handoff.

A single **README** documents actual prerequisites, setup, provider configuration, seed/rebuild commands, local run, tests, Vultr deployment, containment check, and known limitations. Exact commands belong in the implemented README, not in speculative founding documents. Record any genuine deployment blockers without claiming a deployment succeeded.

No additional PRD, architecture-decision collection, design-system document, or task-management service is required. This spec is the acceptance contract; the short project brief is the introduction.

## 18. Future work — do not implement now

Add real-data integrations, continuous analysis and trends, richer outcome evidence, and support for multiple datasets only after proving the core experience. Investigate stronger privacy mechanisms, threat modeling, adversarial evaluations, retention controls, and authentication before real customer use.

A later extension can turn approved aggregate findings into fictional customer environments and run an assistant through them in sandboxes. That discover → synthesize → simulate loop belongs to a later product iteration. Current user-story generation is an illustration, not a simulation.

## 19. Influences

### Clio: automated discovery with an analyst-facing privacy boundary

[Anthropic blog — Clio: A system for privacy-preserving insights into real-world AI use](https://www.anthropic.com/research/clio)

[Research paper — Clio: Privacy-Preserving Insights into Real-World AI Use](https://arxiv.org/abs/2412.13678)

The conceptual influence is facet extraction, grouping by meaning, generalized cluster descriptions, and hierarchical exploration instead of routine transcript inspection. The supplied pipeline illustration is the reference for the distinction between private intermediate representations and analyst-visible clusters.

The paper describes embeddings, k-means, layered privacy checks, and aggregation thresholds. logless deliberately simplifies the grouping mechanism, adds Jev classification and representative stories, and prioritizes generalization over blanket rarity suppression. It is an inspired prototype, not a reproduction of the research or a claim to its evaluated privacy results.

### Compound AI systems

[Databricks — What are Compound AI Systems?](https://www.databricks.com/blog/what-are-compound-ai-systems)

The architectural influence is the combination of specialized components. In logless, GLM reasons and writes, Jev makes bounded judgments, and executed code supplies checked numerical evidence. The split must serve the user flow rather than add agents for their own sake.

### Jev's responsive interaction patterns

[Jevable](https://jevable.com/) · [TypeSafe cookbooks](https://docs.typesafe.ai/cookbooks) · [Semantic-find cookbook](https://docs.typesafe.ai/cookbooks/semantic_find)

Borrow the visible connection between meaning and immediate interface feedback. Semantic search over published clusters is the prototype's interactive expression of that idea. Demo-specific speed claims are not performance guarantees for logless.

### Stripe-inspired customer understanding

[Podcast transcript supplied by the project team](https://www.usetranscribe.io/yt/P5iICDVn5gc/stripe-financial)

The team's quoted excerpt describes fictionalized customer environments for experiencing real-world product problems. That motivates making findings tangible through stories now and possible simulation later. This specification relies on the supplied excerpt, not an independently verified full transcript.

### Required execution environment

The supplied *CV Hackathon Challenge 1 — Agent Sandboxing* defines the VM, inference, execution, containment, and submission requirements. [Vultr Serverless Inference provisioning](https://docs.vultr.com/products/serverless/inference/provisioning) and the [live model catalog](https://api.vultrinference.com/v1/models) are integration references. The organizer's Jev exception is a project-team-confirmed requirement.
