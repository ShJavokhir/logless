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
    name: "WildChat-1M"
    source_url: string
    revision: string
    license: "ODC-BY-1.0"
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
    stats_source?: 'sandbox' | 'local-reference'
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

export type Intent = "usage" | "friction"

export type AnalysisRequest = { intent: Intent; snapshot_id: string }
export type RunIdResponse = { run_id: string }

export type RunState =
  | "queued"
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

export type Containment = {
  deadline_ms: number
  elapsed_ms: number
  killed: boolean
  container_removed: boolean
  app_health: "ok" | "degraded"
  followup_passed: boolean
  leak_attempt_rejected: boolean
  leak_rejection_checks: string[]
}

export type Run = {
  run_id: string
  kind: "analysis" | "story" | "containment"
  intent: Intent | null
  snapshot_id: string
  state: RunState
  created_at: string
  updated_at: string
  stages: RunStage[]
  attempts: number // sandbox executions used (max 2 for analyses)
  code: string | null // the GLM-written program (contains no data)
  receipt: Receipt | null // last sandbox execution
  verdict: Verdict | null
  result: UsageResult | FrictionResult | null // only after the gate passed
  explanation: { text: string; metric_refs: string[] } | null // {{metric}} placeholders filled from `result`
  containment: Containment | null
  error: { code: string; message: string } | null // never raw stderr
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
