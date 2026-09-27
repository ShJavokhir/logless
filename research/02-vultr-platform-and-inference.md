# Vultr platform and inference: implementation research

Research date: **September 26, 2026**. Public model snapshot retrieved at **17:06:43 UTC**. All external actions in this research were read-only. No account was accessed, resource provisioned, paid inference call sent, or credit redeemed.

This memo distinguishes **event requirements**, **verified public API observations**, **vendor documentation**, and **our implementation recommendations**. Advertised model capabilities are not the same as successful authenticated smoke tests.

## 1. Decisions that matter before coding

1. **Build the actual control plane on a Vultr VM.** Both tracks require a VM backend. Track 2 additionally makes Vultr the system of record; a static frontend with its real backend elsewhere is a poor fit. Put run state, orchestration, application APIs, and artifacts under the Vultr deployment.
2. **Use Vultr Serverless Inference for every agent LLM call if entering Track 1.** It is optional for Track 2. The event does not provide Vultr GPUs. These are requirements from the supplied guide and track briefs, not new directions to execute their setup commands.
3. **Fix the guide's model URL immediately:** `https://api.vultrinference.com/v1/chat/models` returned **HTTP 404** during research; [`https://api.vultrinference.com/v1/models`](https://api.vultrinference.com/v1/models) returned **HTTP 200**, unauthenticated, with 19 entries.
4. **Select models using the live catalog, then benchmark the actual task.** Old examples name models missing from today's catalog. Do not choose a model because an older tutorial hardcodes it.
5. **Start with a CPU VM and external inference.** My default recommendation is 4 vCPU / 8 GB for app, builds, database, and a modest worker, with isolated execution capacity kept separate for Track 1. A 2 vCPU / 4 GB VM can support a lean app if browser execution and builds are controlled.
6. **Choose a deployment route once:** plain Docker Compose for a small team comfortable with Linux; Coolify for visual deployment/rollback; Supabase when auth/realtime/storage materially reduce product work. Running all three management layers adds setup work.

Event-source files: [Challenge 2](/Users/creepy/Downloads/themes/CV%20Hackathon_%20Challenge%202%20%28Future%20of%20Work%29.md) and [participant guide](/Users/creepy/.codex/attachments/b5a28765-b03a-4ea9-8065-0059113ab721/Pasted%20text.txt).

## 2. Current inference surface

Use `https://api.vultrinference.com/v1` as the inference base URL. The infrastructure API is a different service: `https://api.vultr.com/v2`.

| Surface | Current public contract / observation | Build implication |
|---|---|---|
| `GET /models` | Public catalog; optional `X-Vultr-Model-Type: chat` filter | Validate exact model IDs at startup |
| `POST /chat/completions` | Chat, tools, streaming, reasoning | Best documented agent integration path |
| `POST /messages` | Anthropic-compatible message format | Possible adapter path; test framework assumptions |
| `POST /responses` | Responses-compatible route, small documented schema | Do not assume full feature parity |
| Tool schemas | `tools`, `tool_choice`, function `strict` | Validate arguments locally regardless |
| Structured text | No chat `response_format` or `json_schema` in inspected schema | JSON mode/Structured Outputs remain unverified |
| Streaming | SSE; text models advertise streaming | Stream progress but persist authoritative run state |
| Reasoning | `max_completion_tokens` includes thinking; default 32,768 | Set explicit limits |
| Budget enforcement | Depends on catalog `reasoning.supports_max_tokens` | An accepted budget may not be enforced |
| `GET /usage`, `/health` | Usage and cluster-health routes | Verify with the inference credential later |

The API documents `-normalize` model suffixes for response compatibility and `:express` for budget behavior. Use these only after testing. Its chat message schema is less expressive than its own tool/multimodal examples; schema generation alone may be insufficient. [Official inference API, version 1.1.3](https://api.vultrinference.com/).

### Credentials and provisioning

The account/organization API key controls infrastructure; an inference subscription has its **own inference API key**. Keep both server-side, and never inject the infrastructure credential into an execution sandbox. Creating inference through the console requires a label and acknowledgement of supported models/charges. The Terraform resource similarly takes a label and returns an inference key. [Provisioning](https://docs.vultr.com/products/compute/serverless-inference/provisioning), [inference Terraform resource](https://docs.vultr.com/reference/terraform/resources/inference).

The console's inference **Usage** page is the documented place to inspect usage by endpoint. Use that to reconcile application-side usage logs after the first successful requests. [Monitoring](https://docs.vultr.com/products/compute/serverless-inference/management/monitor).

### Tool calling: the useful official example

Vultr's tool-calling guide shows the two-stage protocol: send tool definitions; receive an assistant tool request; execute the function; append the assistant request plus a tool result tied to its call ID; ask the model to continue. The sample Python program is linked from the guide. Its model name is old, so substitute a live catalog ID. [Tool-calling guide](https://docs.vultr.com/how-to-use-tool-calling-with-vultr-serverless-inference), [Vultr-owned sample script](https://github.com/vultr-marketing/code-samples/blob/main/vultr-inference-examples/tool-calling-weather.py).

Our implementation recommendation: keep the loop in the backend worker, allowlist tool names, validate arguments with a local schema, require idempotency for writes, enforce a maximum number of steps, persist every call/result, and route executable code/browser actions into the sandbox layer. A function schema is an input format, not an authorization boundary.

### Vision, documents, audio, and images

The catalog advertises image input for the current chat models, with audio/video on a subset; these are **metadata claims awaiting smoke tests**. The API's multipart vision examples and its terse string-only chat schema are not fully aligned. Test a small JPEG or PNG through the actual model before building an image-heavy flow.

Vultr's July 3 document-retrieval guide demonstrates page-image reranking through `/rerank`, compressed base64 images, approximately 1 MB request bodies, and about 1.3 megapixels per page. It states that this family has no serverless embeddings route. However, the guide's model IDs differ from today's catalog and its Prime tier is absent from the snapshot. Today's retriever metadata also lists text input only, despite the visual guide. Treat visual reranking as a **specific integration experiment**, not a guaranteed capability. [VultronRetriever guide](https://docs.vultr.com/how-to-rank-documents-with-vultronretriever-on-vultr-serverless-inference).

The catalog includes image generation (`z-image-turbo`) but no text-to-speech output model, although speech routes exist in the API reference. Endpoint existence does not establish model availability. Basic RAG or basic image analysis is also prohibited by the participant guide; these can support a substantial workflow, not serve as its whole product.

## 3. Live model catalog and pricing snapshot

Source: a public GET to [`/v1/models`](https://api.vultrinference.com/v1/models). Preserved locally as [vultr-models-2026-09-26.json](/Users/creepy/dev/projects/vultr-hackathon/research/evidence/vultr-models-2026-09-26.json), including source URL and retrieval timestamp. The table converts `cost_usd` per token to **USD per million tokens**. This is a factual catalog snapshot, not a claim of measured accuracy, latency, availability to our account, or guaranteed billing.

### Text-output models

All rows below advertise streaming. `T/I/A/V` means text/image/audio/video input. “Budget” is the catalog's enforced reasoning-token-budget flag. Context is the advertised text input context ceiling; it should not be interpreted as a tested maximum usable prompt or output.

| Exact model ID | Input | Context tokens | Input $/M | Output $/M | Tools | Budget |
|---|---|---:|---:|---:|---|---|
| `deepseek-v4-flash-0731` | T/I | 1,048,576 | 0.10 | 0.25 | Yes | No |
| `deepseek-v4.1-flash` | T/I | 1,048,576 | 0.15 | 0.60 | Yes | Yes |
| `glm-5.2` | T/I | 1,048,576 | 0.75 | 3.00 | Yes | Yes |
| `glm-5.3` | T/I | 1,048,576 | 0.75 | 3.00 | Yes | Yes |
| `glm-5.3-flash` | T/I/V | 1,048,576 | 0.10 | 0.35 | Yes | Yes |
| `glm-5.x-menthol` | T/I | 202,752 | 0.40 | 1.75 | Yes | Yes |
| `laguna-s-2.1` | T/I | 1,048,576 | 0.09 | 0.18 | Yes | No |
| `mimo-v2.6-flash-rl` | T/I/A/V | 1,048,576 | 0.10 | 0.25 | Yes | No |
| `mimo-v2.6-pro-rl` | T/I/A/V | 1,048,576 | 0.40 | 0.80 | Yes | No |
| `minimax-m3` | T/I/V | 524,288 | 0.20 | 0.90 | Yes | Yes |
| `muse-glimmer-30b` | T/I/V | 131,072 | 0.25 | 1.00 | Yes | Yes |
| `nemotron-3-nano-omni-30b-a3b-reasoning` | T/I/A/V | 262,144 | 0.10 | 0.25 | Yes | Yes |
| `nemotron-3.5-content-safety` | T/I | 131,072 | 0.05 | 0.15 | No | Yes |
| `qwen3.8-27b` | T/I/V | 262,144 | 0.15 | 1.00 | Yes | Yes |
| `qwen3.8-flash-next` | T/I/V | 262,144 | 0.10 | 0.20 | Yes | Yes |

### Other catalog entries

| Exact model ID | Catalog role | Advertised charge |
|---|---|---|
| `bge-reranker-v2-m3` | Reranking | $0.05/M tokens, labeled completion |
| `vultron-retriever-core-qwen3.5-4.5b` | Reranking | $0.10/M tokens, labeled completion |
| `vultron-retriever-flash-qwen3.5-0.8b` | Reranking | $0.05/M tokens, labeled completion |
| `z-image-turbo` | Image generation | $0.02/megapixel |

All 19 entries report **US / `atl`** as their datacenter in this snapshot. That is more specific than the platform's general global-infrastructure marketing. Do not claim our selected model is running in Silicon Valley just because the VM is there.

### Model selection strategy

This is a proposed experiment, not an unverified leaderboard:

- Benchmark `qwen3.8-flash-next` and `glm-5.3-flash` first for low-cost, tool-enabled workflows with an advertised enforceable reasoning budget.
- Add `glm-5.3` as a higher-price comparison on the hardest task examples. Price alone does not prove it is better.
- If the product depends on audio or video input, include `mimo-v2.6-pro-rl` or `nemotron-3-nano-omni-30b-a3b-reasoning` and test accepted payload formats immediately.
- Keep a second **Vultr** model configurable as fallback for Track 1. A silent fallback to another provider would violate the supplied Track 1 requirement.
- Compare requested and returned model IDs in logs, detect missing tool calls, and fail visibly if the expected workflow did not execute. Avoid relying on provider defaults.

Use five representative tasks and two adversarial inputs; measure complete-task success, valid tool arguments, tool-selection correctness, elapsed time, token cost, and recovery after tool failure. Test with the actual tool descriptions and realistic tool outputs; one chat question does not establish agent reliability.

## 4. Minimal inference smoke test to adapt

The following is an original, **unexecuted** Node.js example using standard `fetch`. It validates catalog membership before an authenticated call. Set secrets privately. Keep it in server code, not a browser bundle. It intentionally uses ordinary chat before layering tools or framework adapters.

```js
const base = "https://api.vultrinference.com/v1";
const model = process.env.VULTR_MODEL;
const apiKey = process.env.VULTR_INFERENCE_API_KEY;
if (!model || !apiKey) throw new Error("Missing server configuration");

const catalogResponse = await fetch(`${base}/models`, {
  signal: AbortSignal.timeout(10_000),
});
if (!catalogResponse.ok) throw new Error(`Catalog HTTP ${catalogResponse.status}`);
const catalog = await catalogResponse.json();
if (!catalog.data.some((entry) => entry.id === model)) {
  throw new Error(`Configured model is absent from the live catalog: ${model}`);
}

const response = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    messages: [{role: "user", content: "Return the single word READY."}],
    max_completion_tokens: 1024,
    temperature: 0,
    stream: false,
  }),
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`Inference HTTP ${response.status}`);
const result = await response.json();
console.log({
  requestedModel: model,
  returnedModel: result.model,
  content: result.choices?.[0]?.message?.content,
  finishReason: result.choices?.[0]?.finish_reason,
  usage: result.usage,
});
```

Once that works, add a harmless tool such as `lookup_fixture_order({order_id})`. Force a tool call, validate JSON, return deterministic fixture data, and confirm a final answer. Then test streaming and only afterward wire the real application workflow. Reduce or increase output allowance based on observed reasoning behavior; a short allowance can be consumed before visible output.

The vendor's [Node.js introduction](https://docs.vultr.com/how-to-use-vultr-serverless-inference-in-nodejs) is useful for request wiring; its older model examples are not the source of truth. The [Python introduction](https://docs.vultr.com/how-to-use-vultr-serverless-inference-in-python) likewise shows HTTP/SDK patterns, but includes the obsolete catalog URL and an `Authorization ` header spelling with trailing whitespace in its direct-request example. Use the standard `Authorization` header shown above.

## 5. VM plans, regions, and realistic event cost

These values were read directly from [`GET /v2/plans?type=vc2`](https://api.vultr.com/v2/plans?type=vc2), not inferred from old pricing articles. CPU is shared. Plan availability can change independently of published price.

Selected plan rows, Silicon Valley availability, Ubuntu identifiers, and the three marketplace app rows are preserved with source URLs and retrieval times in [vultr-platform-2026-09-26.json](/Users/creepy/dev/projects/vultr-hackathon/research/evidence/vultr-platform-2026-09-26.json). A second read on September 26 found no changes to the facts reported here.

| Plan | vCPU | RAM | Local SSD | Transfer field | USD/hour | USD/month field |
|---|---:|---:|---:|---:|---:|---:|
| `vc2-1c-2gb` | 1 | 2 GB | 55 GB | 2,048 GB | 0.014 | 10 |
| `vc2-2c-2gb` | 2 | 2 GB | 65 GB | 3,072 GB | 0.021 | 15 |
| `vc2-2c-4gb` | 2 | 4 GB | 80 GB | 3,072 GB | 0.027 | 20 |
| `vc2-4c-8gb` | 4 | 8 GB | 160 GB | 4,096 GB | 0.055 | 40 |

These are API base prices, not an all-in quote. The API includes location-specific prices; for example, São Paulo differs. Recheck the exact region, add-ons, billing display, and account limits before creating anything.

[`GET /v2/regions/sjc/availability?type=vc2`](https://api.vultr.com/v2/regions/sjc/availability?type=vc2) listed the 4 GB and 8 GB plans as available during research. `sjc` is Silicon Valley; other nearby U.S. choices include `lax` and `sea`. [`GET /v2/regions`](https://api.vultr.com/v2/regions) provides locations; [`GET /v2/os`](https://api.vultr.com/v2/os) currently identifies Ubuntu 24.04 x64 as **2284** and Ubuntu 26.04 x64 as **2760**. Ubuntu 24.04 is the conservative match for the currently advertised marketplace images.

Arithmetic for planning, excluding other charges:

- One 4 vCPU / 8 GB VM for 24 hours: `24 × $0.055 = $1.32`.
- Two such VMs for 24 hours: `$2.64`.
- A hypothetical 1,000 agent calls averaging 4,000 input + 1,000 output tokens: at `qwen3.8-flash-next` catalog rates, `$0.40 + $0.20 = $0.60`; at `glm-5.3` rates, `$3.00 + $3.00 = $6.00`.

These calculations omit reasoning growth, repeated tool context, retries, storage, bandwidth overages, taxes, and add-ons. They suggest that **engineering time and model reliability are likelier event bottlenecks than a small CPU VM's base cost**, assuming the event credit applies as expected.

Vultr's billing support describes a one-hour minimum and continued billing while stopped. Destroying a VM stops its compute charge but deletes its data; snapshots/storage can have their own charges. [Server billing](https://docs.vultr.com/support/platform/billing/how-am-i-billed-for-my-servers), [stopped-instance billing](https://docs.vultr.com/support/platform/billing/are-stopped-instances-still-billed-on-vultr).

### Credits: explicit unresolved points

The supplied participant guide says **$200 per participant**; the Track 2 brief says **$200 per team leader**. Do not extrapolate four coupons or a pooled $800 budget. Ask the event desk to resolve the difference and verify the account's redeemed balance, expiry, product coverage, and inference eligibility.

The generic billing documentation says promotional credits expire and normally require a valid card or PayPal on the account; event-specific terms may differ. No event coupon was supplied or inspected here. [Vultr billing PDF, promotional-code FAQ](https://docs.vultr.com/public/doc-assets/pdfs/collection_item/platform-billing.pdf).

The March 10 inference cost FAQ still says **$0.55/M input and $2.75/M output**. The April platform release notes describe migration to per-model pricing, and today's catalog supplies per-model costs. Prefer the current catalog and authenticated billing UI, and flag discrepancies to Vultr. [Older flat-pricing support page](https://docs.vultr.com/support/products/serverless/how-do-i-monitor-the-usage-and-cost-of-my-vultr-serverless-inference-subscription), [release notes](https://docs.vultr.com/platform/release-notes).

## 6. Deployment paths: what they save and cost

| Path | Good fit | Expected setup work | Our recommendation |
|---|---|---|---|
| Plain Ubuntu + Docker Compose | Small team comfortable with a shell | Proxy/TLS, env files, logs, restart policy, backup | Smallest operational surface |
| Coolify marketplace | Frequent app deploys, visual logs/health checks | Initial admin, repository, build settings, domains | Strong default accelerator |
| Supabase marketplace | Product needs auth, SQL, realtime, storage | Keys, URLs, RLS, callbacks, mail/auth settings | Choose when these services earn their complexity |
| Coolify + Supabase + separate runner | Richer product and enough team capacity | More services and resource planning | Viable, but avoid adopting everything by default |

### Coolify

Vultr's marketplace uses `image_id: "coolify"` or CLI `--image coolify`. The guide covers public Git repository deployment, Dockerfile/Compose/Nixpacks choices, runtime/build environment variables, health checks, and domain setup. Its initial dashboard is on port 8000. Its default `sslip.io` URL is HTTP, with a warning about shared-domain certificate limitations; plan HTTPS explicitly. [Vultr Coolify application guide](https://docs.vultr.com/how-to-deploy-an-application-with-vultr-coolify-marketplace-app).

Coolify's own baseline is **2 CPU cores, 2 GB RAM, 10 GB disk**, before application workloads. Builds on the deployment host consume the same resources as the app. This makes 8 GB a comfortable starting recommendation for a full-stack hackathon app, subject to measurement. [Coolify requirements](https://coolify.io/docs/start-with-self-hosted), [server roles and shared resources](https://coolify.io/docs/core/infrastructure/servers/overview), [build servers](https://coolify.io/docs/core/infrastructure/servers/build-servers).

For the NetBird bonus, adapt ingress: route public application traffic through NetBird and keep app ports private. The generic Coolify guide's public 80/443 pattern is not the bonus architecture. A separate NetBird memo should decide the final network topology.

### Supabase

Vultr's marketplace uses `image_id: "supabase"` or `--image supabase`. The Next.js guide distinguishes browser-safe anonymous access from server-only service-role credentials and demonstrates a path proxy to the API gateway. Its sample table policies allow every row; replace these with tenant/user ownership checks. Its `nohup` deployment example also deserves a proper restart supervisor or container restart policy for the demo. [Vultr Next.js + Supabase guide](https://docs.vultr.com/how-to-deploy-a-nextjs-application-with-vultr-supabase-marketplace-app).

The marketplace setup guide describes its generated environment and keys. Follow the installed version's instructions, rotate default/example secrets, and verify externally visible URLs before enabling auth redirects. [Vultr Supabase marketplace setup](https://docs.vultr.com/how-to-use-vultr-s-supabase-marketplace-application).

Upstream self-hosted Supabase currently specifies **2 cores / 4 GB RAM / 40 GB SSD minimum**, with **4 cores / 8 GB / 80 GB recommended**. Unneeded services can be removed. Upstream's latest setup now documents asymmetric signing-key helpers; a marketplace image can lag that flow, so inspect its version rather than mixing instructions blindly. [Supabase Docker self-hosting](https://supabase.com/docs/guides/self-hosting/docker).

A self-hosted deployment makes the team responsible for operating-system maintenance, backups, database health, and uptime. This is useful context for product claims: a functioning hackathon deployment is not evidence of a fully managed enterprise service. [Supabase self-hosting overview](https://supabase.com/docs/guides/self-hosting).

## 7. Infrastructure automation and exact identifiers

The public marketplace catalog was paginated. Following its cursor found these current entries:

| Product | `image_id` | Marketplace numeric ID | Advertised image |
|---|---|---:|---|
| Coolify | `coolify` | 1265 | Ubuntu 24.04 |
| Supabase | `supabase` | 1266 | Ubuntu 24.04 |
| NetBird Server | `netbird-server` | 1334 | Ubuntu 24.04 LTS |

Use `image_id` for marketplace deployment; do not substitute numeric app ID. [Live applications API](https://api.vultr.com/v2/applications?type=marketplace), [Terraform instance resource](https://github.com/vultr/terraform-provider-vultr/blob/master/website/docs/r/instance.html.markdown).

The official CLI's latest release observed was **v3.11.0** (August 7, 2026), and the Terraform provider's was **v2.32.0** (July 14, 2026). Vultr's Terraform landing page still shows 2.27.1. Pin a known current version and commit the lockfile instead of copying the old pin unquestioningly. [CLI releases](https://github.com/vultr/vultr-cli/releases), [provider releases](https://github.com/vultr/terraform-provider-vultr/releases), [older reference example](https://docs.vultr.com/reference/terraform).

### CLI workflow, for later execution

The official CLI supports JSON output, environment authentication via `VULTR_API_KEY`, and discovery commands. Commands below are **examples, not actions taken**. Replace existing-key/firewall IDs after validating them.

```sh
brew install vultr/vultr-cli/vultr-cli
vultr-cli version
vultr-cli regions list --output json
vultr-cli plans list --output json
vultr-cli os --output json
vultr-cli instance create --help

# Select one route: fresh OS OR marketplace image.
vultr-cli instance create \
  --region sjc --plan vc2-4c-8gb --os 2284 \
  --label agent-arena-control --host arena-control \
  --ssh-keys EXISTING_SSH_KEY_ID --firewall-group EXISTING_FIREWALL_ID

# Alternative image selection: replace --os 2284 with --image coolify.
vultr-cli inference create --label agent-arena-inference
```

The exact create flags were checked against the [official instance command implementation](https://github.com/vultr/vultr-cli/blob/master/cmd/instance/instance.go); inference commands against [its implementation](https://github.com/vultr/vultr-cli/blob/master/cmd/inference/inference.go). Setup and installation reference: [official CLI repository](https://github.com/vultr/vultr-cli).

### Terraform starting point, for later adaptation

This original minimal example assumes existing SSH/firewall IDs. It provisions a fresh OS VM and an inference subscription; it deliberately does not pretend to be an application deployment. Do not put API credentials in the file. Terraform state can contain generated credentials, so keep state out of a public repository.

```hcl
terraform {
  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "2.32.0"
    }
  }
}

provider "vultr" {} # VULTR_API_KEY supplied privately

variable "ssh_key_id" { type = string }
variable "firewall_group_id" { type = string }

resource "vultr_instance" "control" {
  region            = "sjc"
  plan              = "vc2-4c-8gb"
  os_id             = 2284
  label             = "agent-arena-control"
  hostname          = "arena-control"
  ssh_key_ids       = [var.ssh_key_id]
  firewall_group_id = var.firewall_group_id
  user_scheme       = "limited"
  tags              = ["agent-arena-2026", "control"]
}

resource "vultr_inference" "agent" {
  label = "agent-arena-inference"
}

output "control_ip" { value = vultr_instance.control.main_ip }
```

Provider fields and resource definitions: [instance resource](https://github.com/vultr/terraform-provider-vultr/blob/master/website/docs/r/instance.html.markdown), [inference resource](https://github.com/vultr/terraform-provider-vultr/blob/master/website/docs/r/inference.html.markdown). The provider specifically warns that changing an instance hostname can force replacement. Review every plan rather than applying unrelated changes blindly.

### API controls that affect implementation

- The infrastructure API can throttle above **30 requests/second per originating IP**. This is not evidence of an inference quota. Use bounded concurrency and backoff for provisioning polls. [API rate limits](https://docs.vultr.com/support/platform/api/what-rate-limits-apply-to-the-vultr-api).
- Enabling API access without configuring allowed source IPs can leave a key unusable. Remember that a VM's egress IP differs from the laptop's. [API access controls](https://docs.vultr.com/support/platform/users/how-can-i-manage-api-access-for-users).
- Current IAM has service users with separate automation credentials and roles; older “one key per account” support answers do not describe the full newer IAM system. Prefer an automation identity with the needed permissions. [IAM user types](https://docs.vultr.com/support/platform/iam/what-is-a-user-in-vultr-iam), [create service user](https://docs.vultr.com/platform/iam/service-user/how-to-create-a-service-user).
- VM status “running” is not application readiness. Wait for bootstrap completion, database migrations, app health checks, and the real public route. The compute provisioning guide supports cloud-init, SSH keys, firewall groups, and limited users. [Cloud Compute provisioning](https://docs.vultr.com/products/compute/instances/cloud-compute/provisioning).

## 8. A simple architecture that meets the intent

This is our proposed design, not a vendor-mandated architecture:

```text
Browser
  → HTTPS ingress (NetBird reverse proxy when pursuing bonus)
    → Vultr VM: web app + authenticated API
      → persistent run/step/event tables in Postgres
      → worker that owns planning and execution state
        → Vultr Serverless Inference
        → isolated runner on Vultr for code/browser work
      → evidence files + artifact metadata
```

For Track 2, the worker can initially poll Postgres for pending jobs; that avoids a Redis service unless the queue truly needs it. For Track 1, put untrusted execution in a separate constrained environment and keep application/DB/cloud secrets out of it. A dedicated runner VM gives operational separation; the sandbox design memo should define its isolation controls.

Persist these concepts from the first implementation:

| Record | Why it matters to a working demo |
|---|---|
| Run: task, owner, status, start/end, model config | Survives a browser reload; explains what happened |
| Step: inputs, requested tool, validated arguments, result, duration | Makes multi-step work inspectable |
| Approval: actor, proposed action, approved scope, decision | Shows meaningful human control |
| Artifact: storage path, MIME type, hash, producing step | Verifiable executed output |
| Resource: runner/sandbox ID, TTL, cleanup status | Demonstrates lifecycle and bounded cost |
| Usage: request model, returned model, tokens, latency, error | Explains inference reliability and expense |

Use SSE or WebSockets for progress; the browser reconnects to a persisted run, rather than owning its execution. Give each run an idempotency key, a deadline, a maximum tool count, and a cancellation path. A cleanup worker should reconcile stale jobs/resources after crashes.

For artifacts, a local durable volume is enough for a tiny demo if backed up. Vultr Object Storage is an optional S3-compatible route for screenshots, logs, CSV outputs, and generated reports. Its Python guide demonstrates an explicit regional endpoint with Boto3. Use private objects and application-mediated access or short-lived links, and retain hashes/metadata in Postgres. [Vultr Object Storage + Python](https://docs.vultr.com/how-to-use-vultr-object-storage-in-python).

Show an actual task state transition and resulting file/change in the demo. A dashboard can support the workflow, but the participant guide prohibits making the dashboard itself the main product.

## 9. Readiness checklist and proof to collect

### Before committing to a concept

- [ ] Confirm track and mandatory inference routing.
- [ ] Resolve credit eligibility/expiry and verify account resource limits.
- [ ] Read the live model catalog and choose two candidate models.
- [ ] Obtain a successful authenticated text response, then one real tool round trip.
- [ ] Smoke-test required modality: screenshot/PDF page/audio/video, if any.
- [ ] Verify public HTTPS ingress and decide NetBird topology early.
- [ ] Select an actual available VM plan; choose app/runner separation.

### Before building beyond the first vertical slice

- [ ] A user can submit one task through the public web app.
- [ ] The VM persists the task and a worker executes it after the browser disconnects.
- [ ] The model requests a tool and the tool produces a real result.
- [ ] The user can inspect the result and evidence.
- [ ] Timeout, cancellation, malformed tool arguments, and tool failure are visible.
- [ ] An explicit cleanup path removes temporary compute/session resources.
- [ ] Secrets are absent from public repo, browser bundles, and sandbox environment.
- [ ] Database ownership/RLS is demonstrated if multiple users can access the app.

### Before recording/submission

- [ ] Repeat the core workflow from a fresh browser session through the public URL.
- [ ] Record exact deployed commit, model IDs, architecture, and setup steps.
- [ ] Save one successful trace and one controlled failure/recovery trace.
- [ ] Check usage and expiry of any temporary links.
- [ ] Demonstrate the project work created during the hackathon, crediting libraries/marketplace infrastructure separately.
- [ ] Ensure a restart does not lose task history or break the demo.
- [ ] Keep the public URL and account resources alive for the judging window; schedule cleanup only after the team decides retention.

These are proposed implementation checks. This research did not run them against an account.

## 10. Contradictions, unknowns, and source confidence

| Item | Evidence | Action |
|---|---|---|
| Event model URL | `/v1/chat/models` 404; `/v1/models` 200 | Use current endpoint |
| Inference price | Old support flat price vs release notes + live per-model data | Verify billing UI after first calls |
| Event credit ownership | Participant guide vs Track 2 brief | Ask organizer; do not multiply coupons |
| Model names in examples | Older Python/tool/retrieval examples differ from catalog | Configure current exact IDs |
| Structured outputs | No chat JSON-schema response field in inspected contract | Use validated tools or prove support explicitly |
| Vision schema | Catalog and examples advertise multipart input; message schema says string | Integration-test actual payload |
| Visual reranking | July guide shows image input/Prime; catalog has text metadata and no Prime | Test Flash/Core; keep fallback extraction plan |
| Global inference | Marketing global wording; all catalog datacenters currently `atl` | Measure actual latency; avoid residency overclaims |
| TTS availability | Speech route exists; no speech-output catalog model | Treat as unconfirmed |
| Inference throughput | No current numerical per-account inference quota established | Probe gently after authentication; handle 429/5xx |
| SDK compatibility | OpenAI-/Anthropic-compatible routes do not guarantee every SDK feature | Start with direct HTTP; add adapters after smoke test |
| Account resource limits | Public docs describe limits/increase workflow, no account inspected | Verify actual account before designing per-task VMs |
| Full production readiness | Marketplace guides use the phrase; no deployment has been audited | Make narrow, demonstrated claims |

Primary-source status: live GET observations have highest confidence for **what was advertised at retrieval**, not service performance. Vendor guides are implementation references with stated dates. Architecture and prioritization in this memo are engineering recommendations. Authenticated behavior, event coupon terms, quota, actual latency, and model quality remain unverified.

## 11. Reading queue

### Must read before the first deployment

1. [Current model catalog](https://api.vultrinference.com/v1/models) — authoritative IDs/pricing/capability metadata; retrieved September 26.
2. [Inference API reference](https://api.vultrinference.com/) — version 1.1.3 inspected September 26; request shapes and compatibility details.
3. [Inference provisioning](https://docs.vultr.com/products/compute/serverless-inference/provisioning) — updated May 26, 2026; subscription/key setup.
4. [Tool-calling walkthrough](https://docs.vultr.com/how-to-use-tool-calling-with-vultr-serverless-inference) — protocol and executable sample; replace example model.
5. [Cloud Compute provisioning](https://docs.vultr.com/products/compute/instances/cloud-compute/provisioning) — updated June 23, 2026; VM features and choices.
6. [Live plans](https://api.vultr.com/v2/plans?type=vc2) and [Silicon Valley availability](https://api.vultr.com/v2/regions/sjc/availability?type=vc2) — use together, not price alone.
7. [Coolify on Vultr](https://docs.vultr.com/how-to-deploy-an-application-with-vultr-coolify-marketplace-app) — updated April 15, 2026; fastest visual deploy path.
8. [Supabase on Vultr](https://docs.vultr.com/how-to-deploy-a-nextjs-application-with-vultr-supabase-marketplace-app) — updated April 15, 2026; read if choosing Supabase.
9. [Billing when stopped](https://docs.vultr.com/support/platform/billing/are-stopped-instances-still-billed-on-vultr) — destruction and data implications.

### Optional, selected by implementation

- [Official Vultr CLI](https://github.com/vultr/vultr-cli) and [CLI reference](https://docs.vultr.com/reference/vultr-cli) — repeatable operator workflow.
- [Terraform provider](https://github.com/vultr/terraform-provider-vultr) — repeatable architecture and explicit resource inventory.
- [GoVultr v3 SDK](https://pkg.go.dev/github.com/vultr/govultr/v3) — useful if orchestrator is Go; active inference/instance APIs.
- [Platform release notes](https://docs.vultr.com/platform/release-notes) — updated August 31, 2026; helps spot stale tutorials.
- [IAM service users](https://docs.vultr.com/platform/iam/service-user/how-to-create-a-service-user) — updated June 1, 2026; scoped automation identity.
- [Account limits](https://docs.vultr.com/support/platform/billing/how-can-i-increase-my-account-limits) — manual increase process; avoid a last-minute quota surprise.
- [Coolify server requirements](https://coolify.io/docs/start-with-self-hosted) — current upstream requirements.
- [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting/docker) — current upstream stack/security/version behavior.
- [VultronRetriever visual documents](https://docs.vultr.com/how-to-rank-documents-with-vultronretriever-on-vultr-serverless-inference) — July 3, 2026 guide with catalog discrepancies noted above.
- [Object Storage Python](https://docs.vultr.com/how-to-use-vultr-object-storage-in-python) — S3 client wiring for durable evidence.
- [Vultr status](https://status.vultr.com/) — check during troubleshooting; status was not used here to certify service health.
