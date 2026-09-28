// Mirrors docs/CONTRACTS.md sections 5, 6 and 8. Keep in sync with the contract;
// do not add fields here that the API does not send.

// ---------------------------------------------------------------- §5 snapshot

export type Signal = "correction" | "repeat_request" | "assistant_limit" | "complaint"

export const SIGNALS: readonly Signal[] = ["correction", "repeat_request", "assistant_limit", "complaint"]

export type Metrics = {
  conversations: number // union over descendants
  users: number // distinct user pseudonyms, recomputed per node, never summed
  share: number // conversations / snapshot conversations (0..1)
  friction: {
    conversations: number // >=1 observed signal
    share: number | null // friction.conversations / conversations; null if 0 conversations
    unclear: number
    signals: Record<Signal, number>
  }
  languages: { name: string; conversations: number }[] // top 5 by count
}

export type Need = { id: string; text: string }

export type Problem = {
  id: string
  text: string
  signal: Signal | null
  support: "observed" | "common"
}

export type Node = Metrics & {
  id: string
  level: 1 | 2
  parent_id: string | null
  title: string // <= 8 words
  short_title: string // map label, 1–3 words (≤ 24 chars incl. server-side "…" fallback); UI still falls back to `title` if absent
  description: string // 1–2 sentences, generalized
  children?: string[] // categories only: leaf ids
  needs?: Need[] // leaves only
  problems?: Problem[] // leaves only
  surprising?: { flag: boolean; score: number } // leaves only
  is_other?: boolean
}

export type ProvenanceStage = {
  stage: string
  started_at: string
  finished_at: string
  counts: Record<string, number>
  models: string[]
}

export type Snapshot = {
  snapshot_id: string
  created_at: string
  workspace: { name: string; description: string }
  dataset: {
    name: string
    source_url: string
    revision: string
    license: string
    attribution: string
    period_start: string // YYYY-MM-DD
    period_end: string // YYYY-MM-DD
    conversations: number
    users: number
    languages: number
    sample_note: string
    fixtures: { canary_conversations: number; injection_conversations?: number }
  }
  totals: Metrics
  categories: Node[] // level 1, 4–8 of them
  clusters: Node[] // level 2 leaves, 15–35 incl. cl_other
  intended_uses: string[] // what the assistant was designed for; drives "Surprising"
  provenance: {
    pipeline_version: string
    dataset_hash: string
    models: Record<string, string> // role -> model id
    prompt_versions: Record<string, string>
    discovery_rounds: number
    build_seconds: number
    stages: ProvenanceStage[]
  }
}

// ---------------------------------------------------------------- §6 web API

export type Relevance = "relevant" | "unclear" | "not_relevant"

export type SearchRequest = { query: string; snapshot_id: string }

export type SearchResponse = {
  snapshot_id: string
  query: string
  results: { cluster_id: string; relevance: Relevance; p: number }[]
  elapsed_ms: number
}

/** Retired fixed intents (§0 removed them from the API); kept only to read old runs. */
export type Intent = "usage" | "friction"
export type AnalysisIntent = Intent | "question"

/** §0: `question` is the only live intent. */
export type AnalysisRequest = { intent: "question"; snapshot_id: string; question: string }

/** §0: two independent programs per plan — A uses pandas, B only the standard library. */
export type ProgramId = "A" | "B"
export type RunIdResponse = { run_id: string }

export type RunState =
  | "queued"
  | "interpreting"
  | "planning"
  | "executing"
  | "validating"
  | "repairing"
  | "explaining"
  | "completed"
  | "failed"

export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped"

export type RunStage = {
  name: string
  status: StageStatus
  started_at: string | null
  finished_at: string | null
  detail: string | null
}

export type Receipt = {
  job_id: string
  runtime: "runsc" | "runc"
  image: string
  code_sha256: string
  exit_code: number | null
  elapsed_ms: number
  timed_out: boolean
  output_bytes: number
  container_removed: boolean
  limits: {
    cpus: number
    memory_mb: number
    pids: number
    timeout_s: number
    network: "none"
    read_only_root: true
  }
  started_at: string
  finished_at: string
  host: string
}

export type GateCheck = { name: string; passed: boolean; detail: string }

export type Verdict = { passed: boolean; checks: GateCheck[] }

/** The destructive command the containment check runs in a fresh sandbox. */
export type DestructiveResult = {
  command: string // "rm -rf --no-preserve-root /"
  exit_code: number | null // rm's own exit code, reported from inside the sandbox
  refused?: number | null // removals rm reported as refused (a count; the error text never leaves)
  container_removed: boolean
  root_read_only: boolean | null // reported from inside the sandbox
  binaries_intact: boolean | null // reported from inside the sandbox
  next_run_clean: boolean
  contained: boolean
}

export type Containment = {
  /** §6: runaway → cleanup → health → destructive → followup → leak_attempt */
  destructive?: DestructiveResult | null
  deadline_ms: number
  elapsed_ms: number
  killed: boolean
  container_removed: boolean
  app_health: "ok" | "degraded"
  followup_passed: boolean
  leak_attempt_rejected: boolean
  leak_rejection_checks: string[]
}

/**
 * One program version of an analysis (§8b "Attempt history"). `receipt` is null
 * when the static pre-check rejected the program, or the runner supplied no
 * verifiable execution receipt. Failed check names/details distinguish these
 * cases; absence alone does not prove the program never ran. `attempt` numbers program versions;
 * `Run.attempts` counts sandbox executions. `repair_reason` says why this
 * version did not pass (fixed vocabulary) and is null when it passed.
 */
export type Attempt = {
  attempt: 1 | 2
  /** §0: which of the two independent programs this version belongs to */
  program?: ProgramId
  code: string
  code_sha256: string
  receipt: Receipt | null
  verdict: Verdict
  repair_reason: string | null
}

export type Run = {
  run_id: string
  kind: "analysis" | "story" | "prd" | "containment" | "intake" | "brief"
  intent: AnalysisIntent | null
  snapshot_id: string
  state: RunState
  created_at: string
  updated_at: string
  stages: RunStage[]
  attempts: number // sandbox executions used (up to 2 versions per program)
  code: string | null // the GLM-written program (contains no data)
  receipt: Receipt | null // last sandbox execution
  verdict: Verdict | null
  result: UsageResult | FrictionResult | QuestionResult | null // only after the gate passed
  explanation: { text: string; metric_refs: string[] } | null // {{metric}} placeholders filled from `result`
  containment: Containment | null
  error: { code: string; message: string } | null // never raw stderr
  // §8b additions (optional until every backend sends them)
  question?: string | null // sanitized echo of the asked question
  plan?: Plan | null // the validated plan, once interpreting finishes
  attempts_log?: Attempt[] // every sandbox attempt, never overwritten
  // §11 live intake (set when an intake run completes)
  intake?: IntakeSummary | null
}

export type Story = {
  cluster_id: string
  snapshot_id: string
  label: string
  first_name: string
  text: string
  citations: string[]
  model: string
  generated_at: string
}

export type Prd = {
  cluster_id: string
  snapshot_id: string
  label: string
  title: string
  problem: string
  user_stories: string[]
  requirements: string[]
  success_metrics: string[]
  citations: string[]
  metrics_used: { name: string; value: string }[]
  priority: { level: "P0" | "P1" | "P2" | null; rank: number | null; of: number; basis: string }
  model: string
  generated_at: string
}

export type PrdResponse = { status: "ready"; prd: Prd } | { status: "pending"; run_id: string }

export type StoryResponse = { status: "ready"; story: Story } | { status: "pending"; run_id: string }

export type EvalCheck = {
  id: string
  name: string
  value: string
  target: string
  passed: boolean | null
  detail: string
}

export type EvalReport = { snapshot_id: string; generated_at: string; checks: EvalCheck[] }

export type Health = {
  status: "ok" | "degraded"
  sandbox: "reachable" | "unreachable"
  snapshot_id: string
}

// ---------------------------------------------------------------- §8 results
// The contract gives these as JSON examples only; these types transcribe them.

export type UsageRow = { cluster_id: string; conversations: number; users: number; share: number }

export type UsageResult = {
  intent: "usage"
  snapshot_id: string
  total_conversations: number
  rows: UsageRow[]
}

export type FrictionRow = {
  cluster_id: string
  conversations: number
  friction_conversations: number
  friction_share: number
  correction: number
  repeat_request: number
  assistant_limit: number
  complaint: number
  unclear: number
}

export type FrictionResult = {
  intent: "friction"
  snapshot_id: string
  total_conversations: number
  rows: FrictionRow[]
}

// ---------------------------------------------------------------- §8b questions

export type PlanSignal = "any_friction" | Signal

export type Plan = {
  group_by: "leaf" | "category" | "subtheme"
  scope_category_id: string | null // restrict to one category (group_by "leaf" or "subtheme")
  scope_leaf_id?: string | null // restrict to one workflow's sub-themes (group_by "subtheme"); absent on older runs
  measure: "conversations" | "people"
  signal: PlanSignal | null // null = no filter
  rank_by: "count" | "share" // share = count ÷ base (same measure, no signal filter, per group)
  limit: number // 1..10
}

export type QuestionRow = { id: string; count: number; base: number; share: number }

export type QuestionResult = {
  intent: "question"
  snapshot_id: string
  plan: Plan
  rows: QuestionRow[] // rank_by desc, then id asc; at most `limit`. ids are categories, workflows or sub-themes
  total_count: number // over the whole scope, excluding Other
  total_base: number
}

// ---------------------------------------------------------------- §11 live intake

export type Decision = "observed" | "not_observed" | "unclear"

export type IntakeStage = "deciding" | "filing" | "gating" | "publishing" | "evaluating" | "done"

export type IntakeEvent = {
  seq: number
  t_ms: number // since the run started
  leaf_id: string // cl_other below the cutoff
  p: number // Jev's top probability for the theme choice
  friction: Record<Signal, Decision>
  language: string
  turns: number
  summary: string | null // withheld by the live API; legacy/mock summaries are never rendered
}

export type IntakeCounters = {
  total: number
  decided: number
  per_second: number
  p50_ms: number
  decisions_per_conversation: number
}

export type IntakeEventsResponse = {
  run_id: string
  state: "running" | "completed" | "failed"
  stage: IntakeStage
  counters: IntakeCounters
  events: IntakeEvent[]
}

export type IntakeDelta = {
  id: string
  conversations_before: number
  conversations_after: number
  friction_share_before: number | null
  friction_share_after: number | null
}

export type IntakeSummary = {
  batch_size: number
  decided: number
  other: number
  published_snapshot_id: string
  base_snapshot_id: string
  deltas: IntakeDelta[] // top 8 by absolute change
}

export type IntakeStatus = { ready: boolean; batch_size: number; base_snapshot_id: string | null }

// ---------------------------------------------------------------- sub-themes (map layer)

/** k-means sub-cluster inside one leaf; `rest` folds the ones under the size floor (never titled). */
export type Subtheme = { id: string; short_title: string | null; conversations: number; users: number; rest?: boolean }

/** Counts are from the base build; derived (intake) snapshots reuse them as shares of each leaf. */
export type SubthemesResponse = { snapshot_id: string; base_snapshot_id: string; leaves: Record<string, Subtheme[]> }
