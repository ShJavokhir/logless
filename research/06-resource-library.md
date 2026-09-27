# Resource library: what to read, reuse, and postpone

Checked September 26, 2026. Primary documentation and upstream repositories are linked below. “Useful” means relevant to the proposed projects; it does not mean installed, compatible with Vultr without adaptation, or runtime-tested by this research. Detailed platform, runtime and networking sources are also embedded in memos 02–04. The machine-readable source index inventories links across the complete pack.

## Read these first

| Resource | Why it earns attention | Practical use |
|---|---|---|
| [Vultr sandbox tutorial](https://docs.vultr.com/how-to-set-up-agent-sandboxing-on-vultr-cloud-compute) | Directly linked by the challenge; current guide covers Microsandbox on VX1 | Validate the actual VM's KVM capability before committing |
| [Vultr inference provisioning](https://docs.vultr.com/products/serverless/inference/provisioning) | Account and endpoint setup | Enable inference and smoke-test server-side access |
| [Live Vultr model catalog](https://api.vultrinference.com/v1/models) | Current public model capabilities/pricing | Select by required capability, then measure latency |
| [gVisor platforms](https://gvisor.dev/docs/user_guide/platforms/) | Explains available isolation platforms | Evaluate systrap when nested virtualization is unavailable |
| [NetBird reverse proxy](https://docs.netbird.io/manage/reverse-proxy) | Public access over the private mesh | Design the public edge vs closed workload VM correctly |
| [NetBird CLI expose](https://docs.netbird.io/manage/reverse-proxy/expose-from-cli) | Temporary per-task URLs | Supervise lifecycle; consult memo 04 for source/doc mismatch |
| [Playwright Docker](https://playwright.dev/docs/docker) | Browser-runtime requirements and security notes | Avoid unmodified root/no-sandbox quickstarts for hostile pages |
| [Playwright trace viewer](https://playwright.dev/docs/trace-viewer) | Inspect browser action history | Turn a failure into a reviewable trace and screenshots |
| [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | Durable human intervention pattern | Useful if using LangGraph; a custom state machine can suffice |
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) | Current deterministic web-task evaluation | Borrow outcome checks and trace-based verification |

## Browser automation building blocks

| Resource | Verified value | Adoption warning / choice |
|---|---|---|
| [Playwright assertions](https://playwright.dev/docs/test-assertions) | Auto-retrying assertions over page state | A screenshot is complementary evidence, not proof a backend transaction committed |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Structured accessibility snapshots and browser tools; Apache-2.0 repo label | Upstream explicitly says it is not a security boundary. Restrict the server and isolate execution |
| [Browser Use](https://github.com/browser-use/browser-use) | MIT Python library supports local browsers; hosted browser/agent services are separate products | Use a Vultr-hosted browser and override model routing; cloud quickstart is not Track 1 compliant by default |
| [Browser Use model configuration](https://github.com/browser-use/browser-use/blob/main/skills/open-source/references/models.md) | `ChatOpenAI` supports custom `base_url` | Verify model-specific tool/vision/JSON behavior with Vultr; keep inference credentials in the orchestrator |
| [Stagehand v4 introduction](https://docs.stagehand.dev/v4/first-steps/introduction) | Natural-language act/extract/observe plus deterministic browser control; custom model callback | Current docs are v4. Older `env: LOCAL` tutorials are v3-era; do not mix versions |
| [Stagehand repository](https://github.com/browserbase/stagehand) | Current SDK and local browser examples | Default hosted model gateway/browser paths need replacement for C1; smoke-test custom Vultr routing first |
| [MagenticLite / Magentic-UI](https://github.com/microsoft/magentic-ui) | MIT research application with approval, takeover and VM isolation patterns | Main now describes MagenticLite. Older 0.1 examples are on a separate branch; use as UX reference unless adaptation is clearly cheaper |
| [Original Magentic-UI research](https://www.microsoft.com/en-us/research/blog/magentic-ui-an-experimental-human-centered-web-agent/) | Co-planning, shared control and action-approval design | Historical design context; do not assume current installation matches the older blog |

**Recommended browser starting point:** direct Playwright and a small typed action interface. Add Browser Use or Stagehand only if the team already knows it or a short integration spike proves it saves time. Browser models, API semantics, runtime isolation and credential placement are independent integration problems.

## Coding-agent references and verification

| Resource | Use for us | Do not infer |
|---|---|---|
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | Minimal observe/act/execute/retry loop; useful adapter reference | A local subprocess backend is a sandbox; benchmark results transfer to our Vultr model |
| [OpenHands / Agent Canvas](https://github.com/OpenHands/OpenHands) | Existing control-plane and agent UX; competitive baseline | Rebranding the application would count as new work |
| [SWE-bench current CLI](https://www.swebench.com/SWE-bench/reference/cli/) | Reproducible inference/evaluation, per-run artifacts and reports | Old command examples still match current v5 conventions |
| [SWE-bench Docker guide](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/docker_setup.md) | Isolation and reproducibility methodology | Full suite is a lightweight hackathon dependency: guide recommends 16GB+ RAM and 120GB free disk |
| [pytest](https://github.com/pytest-dev/pytest) | Compact deterministic fixtures and machine-readable test output | An agent-editable test suite is independent verification |
| [Hypothesis](https://hypothesis.readthedocs.io/en/latest/) | Generate boundary cases from properties for a narrow function or transform | Passing generated cases establishes universal correctness |

For ProofPatch, never import candidate code into the trusted checker. Keep expected values and invariant logic outside candidate execution; exchange only bounded input/output with its sandbox. Apply allowlisted patches to clean source there, rejecting changes to harness/tests/dependency/startup hooks. A pytest run in the same process authority as candidate code is a clean rerun, not tamper-resistant verification, even with read-only test files.

**Pack-wide Track 1 routing rule:** planner, retries, vision/extraction, evaluator helpers and all other runtime agent model requests must run in the trusted Vultr orchestrator through Vultr inference. Keep library model adapters outside the guest. Disable and test for default fallback providers or hosted gateways; only code/browser execution belongs inside the credential-free sandbox.

## Benchmarks, task fixtures and evaluation ideas

These are resources for designing tasks and checking results, not a requirement to reproduce a published score. No external benchmark has been run in this research.

| Resource | Best use | Setup / eligibility caveat |
|---|---|---|
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) | Common browser task environment and custom task interface | Research framework; benchmarks have separate setup requirements |
| [AgentLab](https://github.com/ServiceNow/AgentLab) | Repeated web-agent experiments, trajectories, reproducibility | Extra experiment framework may be unnecessary for ten local demo cases |
| [WorkArena](https://github.com/ServiceNow/WorkArena) | Enterprise task taxonomy: forms, navigation, catalog operations, lists | Current ServiceNow instance access is gated; don't make approval a critical path |
| [WebArena](https://github.com/web-arena-x/webarena) | Self-hosted realistic web applications and outcome-based tasks | Original repo points to newer BrowserGym/AgentLab tooling |
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) | Audited tasks; deterministic evaluators and network traces | Pin dataset/version; its benchmark score is not our product's score |
| [MiniWoB++](https://miniwob.farama.org/) | Small browser primitives to diagnose click/form reliability | Too synthetic to be the main enterprise demo on its own |
| [TheAgentCompany](https://github.com/TheAgentCompany/TheAgentCompany) | Cross-tool work examples with explicit outcome evaluators | Full stack includes several services and 30+GB storage. Its permissive Docker-socket quickstart is not our hardened deployment design |
| [τ-bench / tau2-bench repo](https://github.com/sierra-research/tau2-bench) | Policy-constrained support scenarios and task evaluation | Repo now announces τ³; banking grading changed in v1.0.1. Pin a version and avoid stale score comparisons |
| [AgentDojo](https://agentdojo.spylab.ai/) | Evaluate utility separately from prompt-injection success | API is evolving; use bounded local synthetic attack fixtures |
| [AgentDojo custom tasks](https://agentdojo.spylab.ai/concepts/task_suite_and_tasks/) | Define explicit legitimate and adversarial success conditions | A detector flag is not the same as preventing an unauthorized effect |
| [DoomArena](https://github.com/ServiceNow/DoomArena) | Security-testing framework across browser/tool environments | Prefer a few relevant scenarios over deploying every integration |

Start with ten team-authored cases: normal success, recoverable error, impossible request, malformed response, timeout, cancellation, concurrent users, blocked network target, hostile input and teardown. Make expected states explicit. The small suite is a regression check, not a statistically strong public safety benchmark.

## Data and business workflows

| Resource | Value | Practical use |
|---|---|---|
| [DuckDB CSV import](https://duckdb.org/docs/current/data/csv/overview) | Embedded tabular processing without a data warehouse | Execute transforms over task-scoped input copies |
| [Securing DuckDB](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview) | Explains SQL's ability to reach files, networks and extensions | An embedded query engine does not replace the sandbox boundary |
| [Pandera](https://pandera.readthedocs.io/en/stable/) | Runtime dataframe schemas, checks and error reports | Define invariants once and show violations to the user |
| [Pydantic validation](https://pydantic.dev/docs/validation/latest/get-started/) | Typed request/tool/output validation | Reject malformed action arguments before dispatch |
| [UCI Online Retail](https://archive.ics.uci.edu/dataset/352/online+retail) | Historical transaction data; page states CC BY 4.0 | Attribute if reused; use for realistic data shape, not current economic claims |
| [Open Contracting Data Standard](https://standard.open-contracting.org/latest/en/) | Procurement lifecycle and structured data concepts | Use terminology/schema inspiration; individual datasets can have their own licenses |
| [ERPNext](https://github.com/frappe/erpnext) | Existing order/accounting/inventory behavior to study; GPL-3.0 repo label | Full ERP setup and integration are optional, not MVP prerequisites |

Suggested synthetic fixture contract for Reconcile Room: `invoices`, `purchase_orders`, `receipts`, with integer minor units or deliberate decimal handling, explicit currency, stable row IDs, duplicate keys, partial receipts, one mismatched total and one unresolved ambiguous match. These are our proposed fixture requirements, not data copied from an external organization.

## State, approvals and observability

| Resource | Useful pattern | Decision |
|---|---|---|
| [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | Persisted pause/resume with human input | Keep side effects after approval and bind approval to exact state |
| [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | Checkpoints and durable task state | Do not mistake saved conversation state for exactly-once external effects |
| [Temporal workflow execution](https://docs.temporal.io/workflow-execution) | Durable execution and history | Strong option for teams already fluent with it; unnecessary new infrastructure otherwise |
| [BullMQ workers](https://docs.bullmq.io/guide/workers) | Background jobs and worker lifecycle | Suitable TS option if Redis already exists; cap retries and concurrency |
| [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai) | Shared names for model/tool telemetry | Current conventions moved to this repo. Record metadata without capturing secrets by default |

A persistent database plus a single explicit worker can be sufficient for a hackathon. Store task transitions, output pointers and cleanup state. The product can look polished while honestly documenting single-worker and single-VM limitations.

## Security references that map to concrete implementation work

| Source | Concrete implication |
|---|---|
| [OWASP prompt-injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) | Retrieved pages, code comments and tool output are data; validate actions independently of model compliance |
| [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) | Restrict target schemes and destinations, including resolved addresses and redirects; block metadata and private control-plane reachability |
| [OWASP upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) | Limit input size/type, generate storage names and isolate stored content from app execution |
| [MCP security best practices](https://modelcontextprotocol.io/docs/draft/tutorials/security/security_best_practices) | Tool connectivity requires authentication and authorization; protocol compatibility is not containment |
| [Docker firewall limitations](https://docs.docker.com/engine/install/ubuntu/) | Validate actual externally reachable ports instead of relying on UFW display alone |

The purpose of these references is to support the challenge's actual containment promise. Avoid claiming comprehensive security certification or complete prompt-injection resistance from a short demo.

## Reuse and version checklist

- Record exact release, package version, container digest and source link for each adopted dependency.
- Pin a working dependency set before the final demo; current main branches and unversioned docs change.
- Treat upstream sample code as a starting point. Check where it runs commands, where it sends model requests, what it exposes publicly and where it stores credentials.
- Preserve license/notice files and credit borrowed components. Repository labels above are orientation, not a complete dependency-license audit.
- Keep existing benchmark data and code clearly separate from our newly authored workflow, UI and enforcement code.
- Reject dependency sprawl: one UI stack, one backend, one sandbox strategy, one model adapter, one trace format.
