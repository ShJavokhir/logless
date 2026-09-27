// In-browser mock of the logless API. Runs are Date.now()-driven state
// machines (no timers to clean up); an in-flight analysis for the same
// intent + snapshot is reused, as the contract requires.
//
// URL switches for exercising UI states (mock mode only):
//   ?sandbox=down   health degraded, analyses/containment → 503 sandbox_unreachable
//   ?gate=fail      analyses fail the gate twice and end in state "failed"
//   ?budget=out     live features → 429 budget_exhausted
//   ?snapshot=real  serve src/mocks/real-snapshot.json (a saved copy of the live snapshot)

import { ApiError, type Api } from "@/lib/api"
import type {
  AnalysisIntent,
  EvalReport,
  GateCheck,
  Plan,
  QuestionResult,
  FrictionResult,
  Health,
  Receipt,
  Run,
  RunStage,
  RunState,
  Snapshot,
  StageStatus,
  Story,
  StoryResponse,
  UsageResult,
  Verdict,
} from "@/lib/types"
import snapshotJson from "./snapshot.json"
import { CONTAINMENT_PROGRAM, FRICTION_PROGRAM, FRICTION_PROGRAM_ATTEMPT_1, USAGE_PROGRAM, questionProgram } from "./programs"
import { frictionExplanation, frictionResult, interpretQuestion, questionExplanation, questionResult, usageExplanation, usageResult } from "./results"
import { mockStory } from "./stories"

let SNAPSHOT = snapshotJson as unknown as Snapshot
export const STORY_LABEL = "Fictional user story · Illustrates an aggregate pattern; not a real customer or additional evidence."

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const iso = (ms: number) => new Date(ms).toISOString()
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("")
const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`)

function param(name: string): string | null {
  if (typeof window === "undefined") return null
  return new URLSearchParams(window.location.search).get(name)
}

async function sha256(text: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
  } catch {
    return hex(64)
  }
}

// ---------------------------------------------------------------- run model

type Phase = {
  name: string
  state: RunState
  start: number // ms after creation
  end: number
  detail: string
  doneDetail?: string
  outcome?: StageStatus // status once finished (default "done")
  execution?: number // 1-based sandbox execution index
}

type MockRun = {
  id: string
  kind: Run["kind"]
  intent: AnalysisIntent | null
  question?: string
  plan?: Plan | null
  repairReason?: string | null
  createdAt: number
  phases: Phase[]
  finalState: "completed" | "failed"
  codes: string[] // program per execution
  shas: string[]
  receipts: Receipt[] // per execution
  verdicts: Verdict[] // per validation
  result: UsageResult | FrictionResult | QuestionResult | null
  explanation: Run["explanation"]
  containment: Run["containment"]
  error: Run["error"]
  storyClusterId?: string
}

const LIMITS: Receipt["limits"] = { cpus: 1, memory_mb: 512, pids: 64, timeout_s: 10, network: "none", read_only_root: true }
const HOST = "logless-sandbox-ewr"

function receiptFor(createdAt: number, phase: Phase, sha: string, outputBytes: number, over: Partial<Receipt> = {}): Receipt {
  const started = createdAt + phase.start + 120
  const elapsed = over.elapsed_ms ?? Math.round(phase.end - phase.start - 180)
  return {
    job_id: uuid(),
    runtime: "runsc",
    image: "logless-analysis:1",
    code_sha256: sha,
    exit_code: 0,
    elapsed_ms: elapsed,
    timed_out: false,
    output_bytes: outputBytes,
    container_removed: true,
    limits: LIMITS,
    started_at: iso(started),
    finished_at: iso(started + elapsed),
    host: HOST,
    ...over,
  }
}

// Fixed gate vocabulary (CONTRACTS §8 / §8b); details never echo output values.
function passedChecks(intent: AnalysisIntent, rows: number, bytes: number, plan?: Plan | null): Verdict {
  const q = intent === "question"
  const order = q
    ? `Ordered by ${plan?.rank_by === "share" ? "share" : "count"}, then id`
    : intent === "usage"
      ? "Ordered by conversations, then cluster id (Other last)"
      : "Ordered by friction conversations, then cluster id (Other last)"
  const checks: GateCheck[] = [
    { name: "Result file received", passed: true, detail: "a result file was produced" },
    { name: "Size within 1 MiB", passed: true, detail: `${bytes.toLocaleString("en-US")} bytes` },
    { name: "Strict JSON parse", passed: true, detail: "one JSON object" },
    { name: "Document within structural limits", passed: true, detail: "depth <= 6, strings <= 64 chars" },
    { name: "Only allowlisted field names", passed: true, detail: "all field names are in the schema" },
    { name: "Only allowlisted string values", passed: true, detail: q ? "only intent, snapshot, plan and node ids" : "only intent, snapshot and cluster ids" },
    { name: "Schema matches exactly", passed: true, detail: `${intent} result schema, no extra fields` },
    { name: "Intent matches the request", passed: true, detail: "matches" },
    { name: "Snapshot id is the current snapshot", passed: true, detail: "matches" },
    ...(q ? [{ name: "Plan matches the validated plan", passed: true, detail: "echoed exactly" }] : []),
    { name: q ? "Ids are within the plan's scope" : "Cluster ids belong to this snapshot", passed: true, detail: `${rows} ids, all allowed` },
    { name: "Counts are non-negative integers", passed: true, detail: "ok" },
    { name: q ? "Row count equals min(limit, groups in scope)" : "Every leaf exactly once", passed: true, detail: q ? `${rows} rows` : `${rows} of ${rows} present once` },
    { name: "Total matches the trusted reference", passed: true, detail: "matches" },
    { name: "Counts match the trusted reference", passed: true, detail: "every integer equals the reference" },
    { name: "Shares within 1e-4 of the reference", passed: true, detail: "every share within 1e-4" },
    { name: order, passed: true, detail: "ok" },
  ]
  return { passed: true, checks }
}

function withFailed(v: Verdict, failName: string, detail: string): Verdict {
  return {
    passed: false,
    checks: v.checks.map((c) => (c.name === failName ? { ...c, passed: false, detail } : c)),
  }
}

// ---------------------------------------------------------------- mock api

export async function createMockApi(): Promise<Api> {
  if (param("snapshot") === "real") {
    try {
      const real = await import("./real-snapshot.json")
      SNAPSHOT = (real.default ?? real) as unknown as Snapshot
    } catch {
      // no saved live snapshot: keep the generated one
    }
  }
  const runs = new Map<string, MockRun>()
  const inflight = new Map<string, string>() // `${intent}:${snapshot}` -> run id
  const storyRuns = new Map<string, string>() // cluster id -> story run id
  const sandboxDown = param("sandbox") === "down"
  const gateFails = param("gate") === "fail"
  const budgetOut = param("budget") === "out"
  const budget = () => new ApiError(429, "budget_exhausted", "Global spend cap reached.")

  function isFinished(r: MockRun, now = Date.now()) {
    const last = r.phases[r.phases.length - 1]
    return now - r.createdAt >= last.end
  }

  function toRun(r: MockRun): Run {
    const now = Date.now()
    const t = now - r.createdAt
    const stages: RunStage[] = r.phases.map((p) => {
      const status: StageStatus = t < p.start ? "pending" : t < p.end ? "running" : (p.outcome ?? "done")
      return {
        name: p.name,
        status,
        started_at: t >= p.start ? iso(r.createdAt + p.start) : null,
        finished_at: t >= p.end ? iso(r.createdAt + p.end) : null,
        detail: t >= p.end ? (p.doneDetail ?? p.detail) : t >= p.start ? p.detail : null,
      }
    })
    const running = r.phases.find((p) => t >= p.start && t < p.end)
    const finished = isFinished(r, now)
    const state: RunState = finished ? r.finalState : running ? running.state : t < r.phases[0].start ? "queued" : r.phases.filter((p) => t >= p.end).at(-1)?.state ?? "queued"

    const execs = r.phases.filter((p) => p.execution && t >= p.start)
    const doneExecs = r.phases.filter((p) => p.execution && t >= p.end)
    const planned = r.phases.find((p) => p.state === "planning")
    const codeVisible = !planned || t >= planned.end
    const codeIdx = Math.max(0, execs.length - 1)
    const validations = r.phases.filter((p) => p.state === "validating" && p.name === "validating" && t >= p.end)
    const lastVerdict = validations.length ? r.verdicts[validations.length - 1] ?? null : null
    const gatePassed = !!lastVerdict?.passed
    const explained = r.phases.find((p) => p.state === "explaining" && r.kind === "analysis")

    return {
      run_id: r.id,
      kind: r.kind,
      intent: r.intent,
      snapshot_id: SNAPSHOT.snapshot_id,
      state,
      created_at: iso(r.createdAt),
      updated_at: iso(Math.min(now, r.createdAt + r.phases[r.phases.length - 1].end)),
      stages,
      attempts: execs.length,
      code: r.codes.length && codeVisible ? r.codes[Math.min(codeIdx, r.codes.length - 1)] : null,
      receipt: doneExecs.length ? r.receipts[doneExecs.length - 1] ?? null : null,
      verdict: r.kind === "containment" ? (finished ? (r.verdicts[0] ?? null) : null) : lastVerdict,
      result: gatePassed ? r.result : null,
      explanation: explained && t >= explained.end ? r.explanation : null,
      containment: finished ? r.containment : null,
      error: finished ? r.error : null,
      ...(r.kind === "analysis"
        ? {
            question: r.question ?? null,
            plan: (() => {
              const interp = r.phases.find((p) => p.name === "interpreting")
              return r.plan && (!interp || t >= interp.end) ? r.plan : null
            })(),
            // an attempt is logged once its gate verdict exists
            attempts_log: validations.map((_, i) => ({
              attempt: (i + 1) as 1 | 2,
              code: r.codes[i],
              code_sha256: r.shas[i],
              receipt: r.receipts[i],
              verdict: r.verdicts[i],
              repair_reason: i === 1 ? (r.repairReason ?? null) : null,
            })),
          }
        : {}),
    }
  }

  // Example question that takes the repair path (attempt 1 rejected on shares).
  const REPAIR_QUESTION = /assistant limits most often, as a share/i

  async function newAnalysis(intent: AnalysisIntent, question?: string): Promise<MockRun> {
    const createdAt = Date.now()
    const id = `run_${hex(12)}`
    const q = intent === "question"
    const interp = q ? interpretQuestion(question ?? "", SNAPSHOT) : null
    const T0 = q ? 1350 : 150 // interpreting takes the first ~1.2 s of a question run

    const interpreting: Phase[] = q
      ? [
          {
            name: "interpreting",
            state: "interpreting",
            start: 150,
            end: T0,
            detail: "GLM is mapping the question to a closed-vocabulary plan (it sees titles, not data)",
            doneDetail: interp && "plan" in interp ? "Plan validated against the schema" : "Question can't be expressed as a plan",
            outcome: interp && "plan" in interp ? "done" : "failed",
          },
        ]
      : []

    // Unsupported question: the run ends after interpreting.
    if (interp && "unsupported" in interp) {
      return {
        id, kind: "analysis", intent, question, plan: null, createdAt, phases: interpreting, finalState: "failed",
        codes: [], shas: [], receipts: [], verdicts: [], result: null, explanation: null, containment: null,
        error: { code: "unsupported_question", message: interp.unsupported },
      }
    }

    const plan = interp && "plan" in interp ? interp.plan : null
    const result = q ? questionResult(SNAPSHOT, plan!) : intent === "usage" ? usageResult(SNAPSHOT) : frictionResult(SNAPSHOT)
    const bytes = JSON.stringify(result).length
    const ok = passedChecks(intent, result.rows.length, bytes, plan)
    const explanation =
      result.intent === "question" ? questionExplanation(result) : result.intent === "usage" ? usageExplanation(result) : frictionExplanation(result)
    const repair = intent === "friction" || gateFails || (q && REPAIR_QUESTION.test(question ?? ""))
    const good = q ? questionProgram(plan!) : intent === "usage" ? USAGE_PROGRAM : FRICTION_PROGRAM
    const planningPhase: Phase = {
      name: "planning",
      state: "planning",
      start: T0,
      end: T0 + 1450,
      detail: "GLM is writing a program from the plan and file schema (it sees no data)",
      doneDetail: q ? "Program written for the validated plan" : `Program written from the ${intent} contract and file schema`,
    }

    if (!repair) {
      const phases: Phase[] = [
        ...interpreting,
        planningPhase,
        { name: "executing", state: "executing", start: T0 + 1450, end: T0 + 2500, detail: "Running in the gVisor sandbox · no network · read-only root", doneDetail: "Exit 0 · result.json written", execution: 1 },
        { name: "validating", state: "validating", start: T0 + 2500, end: T0 + 2950, detail: "Egress gate checking every value against the trusted reference", doneDetail: `passed ${ok.checks.length}/${ok.checks.length} checks` },
        { name: "explaining", state: "explaining", start: T0 + 2950, end: T0 + 4900, detail: "GLM is describing the validated result with placeholders only", doneDetail: "model text validated (placeholders only, no digits)" },
      ]
      const sha = await sha256(good)
      return {
        id, kind: "analysis", intent, question, plan, createdAt, phases, finalState: "completed",
        codes: [good], shas: [sha],
        receipts: [receiptFor(createdAt, phases[interpreting.length + 1], sha, bytes, { elapsed_ms: Math.round(jitter(2300, 2700)) })],
        verdicts: [ok], result, explanation, containment: null, error: null,
      }
    }

    // Repair variant: attempt 1 is rejected by one gate check, GLM repairs it.
    const bad = q ? questionProgram(plan!, true) : intent === "friction" ? FRICTION_PROGRAM_ATTEMPT_1 : USAGE_PROGRAM
    const [sha1, sha2] = await Promise.all([sha256(bad), sha256(good)])
    const failName = q ? "Shares within 1e-4 of the reference" : ok.checks[ok.checks.length - 1].name
    const failDetail = q ? "rows[0].share differs from the reference (+4 more)" : "rows[1] is out of order (+12 more)"
    const rejected = withFailed(ok, failName, failDetail)
    const phases: Phase[] = [
      ...interpreting,
      planningPhase,
      { name: "executing", state: "executing", start: T0 + 1450, end: T0 + 2450, detail: "Attempt 1 · gVisor sandbox · no network · read-only root", doneDetail: "Attempt 1 · exit 0 · result.json written", execution: 1 },
      { name: "validating", state: "validating", start: T0 + 2450, end: T0 + 2900, detail: "Egress gate checking attempt 1", doneDetail: `Rejected: ${failName} · nothing released`, outcome: "failed" },
      { name: "repairing", state: "repairing", start: T0 + 2900, end: T0 + 4300, detail: "GLM is fixing the program from the failed check names only (no data)", doneDetail: `Repaired for: ${failName}` },
      { name: "executing", state: "executing", start: T0 + 4300, end: T0 + 5300, detail: "Attempt 2 · gVisor sandbox · no network · read-only root", doneDetail: "Attempt 2 · exit 0 · result.json written", execution: 2 },
      { name: "validating", state: "validating", start: T0 + 5300, end: T0 + 5750, detail: "Egress gate checking attempt 2", doneDetail: gateFails ? "Rejected again · run stopped after 2 attempts" : `passed ${ok.checks.length}/${ok.checks.length} checks`, outcome: gateFails ? "failed" : "done" },
    ]
    if (!gateFails) {
      phases.push({ name: "explaining", state: "explaining", start: T0 + 5750, end: T0 + 7700, detail: "GLM is describing the validated result with placeholders only", doneDetail: "model text validated (placeholders only, no digits)" })
    }
    const execIdx = phases.findIndex((p) => p.execution === 1)
    const execIdx2 = phases.findIndex((p) => p.execution === 2)
    return {
      id, kind: "analysis", intent, question, plan, createdAt, phases, finalState: gateFails ? "failed" : "completed",
      codes: [bad, good], shas: [sha1, sha2], repairReason: failName,
      receipts: [
        receiptFor(createdAt, phases[execIdx], sha1, bytes, { elapsed_ms: Math.round(jitter(2250, 2650)) }),
        receiptFor(createdAt, phases[execIdx2], sha2, bytes, { elapsed_ms: Math.round(jitter(2250, 2650)) }),
      ],
      verdicts: [rejected, gateFails ? rejected : ok],
      result: gateFails ? null : result,
      explanation: gateFails ? null : explanation,
      containment: null,
      error: gateFails ? { code: "gate_rejected", message: "The program's output failed the egress gate on both attempts, so nothing was released." } : null,
    }
  }

  async function newContainment(): Promise<MockRun> {
    const createdAt = Date.now()
    const elapsed = 2000 + Math.round(jitter(9, 19))
    const phases: Phase[] = [
      { name: "runaway", state: "executing", start: 150, end: 150 + elapsed + 60, detail: "Busy-loop program running · deadline 2,000 ms", doneDetail: `Deadline reached · killed at ${elapsed.toLocaleString("en-US")} ms`, outcome: "failed", execution: 1 },
      { name: "cleanup", state: "executing", start: 150 + elapsed + 60, end: 150 + elapsed + 420, detail: "Supervisor removing the container", doneDetail: "Container removed · no orphans with the job label" },
      { name: "health", state: "validating", start: 150 + elapsed + 420, end: 150 + elapsed + 700, detail: "Checking app and runner health", doneDetail: "App health ok · runner accepting jobs" },
      { name: "followup", state: "validating", start: 150 + elapsed + 700, end: 150 + elapsed + 1850, detail: "Running a normal usage analysis in a fresh sandbox", doneDetail: "exit 0 · gate passed 17/17 checks" },
      { name: "leak_attempt", state: "validating", start: 150 + elapsed + 1850, end: 150 + elapsed + 2900, detail: "A program tries to export one row per person", doneDetail: "gate rejected the per-user rows: Only allowlisted field names, Schema matches exactly", outcome: "done" },
    ]
    const sha = await sha256(CONTAINMENT_PROGRAM)
    const started = createdAt + phases[0].start
    return {
      id: `run_${hex(12)}`, kind: "containment", intent: null, createdAt, phases, finalState: "completed",
      codes: [CONTAINMENT_PROGRAM], shas: [sha],
      receipts: [
        {
          job_id: uuid(), runtime: "runsc", image: "logless-analysis:1", code_sha256: sha,
          exit_code: null, elapsed_ms: elapsed, timed_out: true, output_bytes: 0, container_removed: true,
          limits: { ...LIMITS, timeout_s: 2 },
          started_at: iso(started), finished_at: iso(started + elapsed), host: HOST,
        },
      ],
      verdicts: [
        withFailed(
          withFailed(passedChecks("usage", 5050, 999), "Only allowlisted field names", "unknown field 'user' in rows[0]; unknown field 'user' in rows[1] (+18 more)"),
          "Schema matches exactly",
          "missing field at rows[0].share; missing field at rows[0].users (+97 more)",
        ),
      ],
      result: null, explanation: null,
      containment: {
        deadline_ms: 2000, elapsed_ms: elapsed, killed: true, container_removed: true, app_health: "ok",
        followup_passed: true, leak_attempt_rejected: true,
        leak_rejection_checks: ["Only allowlisted field names", "Schema matches exactly"],
      },
      error: null,
    }
  }

  function newStoryRun(clusterId: string): MockRun {
    const createdAt = Date.now()
    return {
      id: `run_${hex(12)}`, kind: "story", intent: null, createdAt, finalState: "completed",
      phases: [
        { name: "writing", state: "explaining", start: 100, end: 1900, detail: "GLM is writing from the cluster summary only (no conversations)", doneDetail: "Draft written from needs and problems" },
        { name: "checking", state: "validating", start: 1900, end: 2500, detail: "Checking the draft for specifics that could identify anyone", doneDetail: "No identifying specifics found" },
      ],
      codes: [], shas: [], receipts: [], verdicts: [], result: null, explanation: null, containment: null, error: null,
      storyClusterId: clusterId,
    }
  }

  const unreachable = () => new ApiError(503, "sandbox_unreachable", "Live analysis unavailable; the saved snapshot is still browsable.")

  return {
    mode: "mock",

    async getSnapshot() {
      await sleep(jitter(280, 420))
      return structuredClone(SNAPSHOT)
    },

    async search(req) {
      const t0 = performance.now()
      await sleep(jitter(160, 320))
      const results = searchClusters(req.query)
      return { snapshot_id: req.snapshot_id, query: req.query, results, elapsed_ms: Math.round(performance.now() - t0) }
    },

    async startAnalysis({ intent, snapshot_id, question }) {
      await sleep(jitter(60, 140))
      if (intent === "question" && (!question || !question.trim() || question.length > 200)) {
        throw new ApiError(422, "invalid_request", "question must be 1–200 characters")
      }
      if (budgetOut) throw budget()
      if (sandboxDown) throw unreachable()
      if (snapshot_id !== SNAPSHOT.snapshot_id) throw new ApiError(409, "stale_snapshot", "This snapshot is no longer current. Reload to see the latest one.")
      const norm = (question ?? "").trim().toLowerCase().replace(/\s+/g, " ")
      const key = intent === "question" ? `question:${norm}:${snapshot_id}` : `${intent}:${snapshot_id}`
      const existing = inflight.get(key)
      if (existing) {
        const r = runs.get(existing)
        if (r && !isFinished(r)) return { run_id: existing }
      }
      const run = await newAnalysis(intent, question?.trim())
      runs.set(run.id, run)
      inflight.set(key, run.id)
      return { run_id: run.id }
    },

    async getRun(runId) {
      await sleep(jitter(30, 80))
      const r = runs.get(runId)
      if (!r) throw new ApiError(404, "not_found", "Run not found.")
      return toRun(r)
    },

    async requestStory(clusterId, snapshotId): Promise<StoryResponse> {
      await sleep(jitter(80, 160))
      if (budgetOut) throw budget()
      const node = SNAPSHOT.clusters.find((c) => c.id === clusterId)
      if (!node) throw new ApiError(404, "not_found", "Cluster not found.")
      const runId = storyRuns.get(clusterId)
      const run = runId ? runs.get(runId) : undefined
      if (run && isFinished(run)) {
        const s = mockStory(node)
        const story: Story = {
          cluster_id: clusterId,
          snapshot_id: snapshotId,
          label: STORY_LABEL,
          first_name: s.first_name,
          text: s.text,
          citations: s.citations,
          model: "glm-5.3",
          generated_at: iso(run.createdAt + run.phases[run.phases.length - 1].end),
        }
        return { status: "ready", story }
      }
      if (run) return { status: "pending", run_id: run.id }
      const fresh = newStoryRun(clusterId)
      runs.set(fresh.id, fresh)
      storyRuns.set(clusterId, fresh.id)
      return { status: "pending", run_id: fresh.id }
    },

    async startContainment() {
      await sleep(jitter(60, 140))
      if (budgetOut) throw budget()
      if (sandboxDown) throw unreachable()
      const run = await newContainment()
      runs.set(run.id, run)
      return { run_id: run.id }
    },

    async getEval() {
      await sleep(jitter(150, 260))
      return evalReport()
    },

    async getHealth(): Promise<Health> {
      await sleep(jitter(40, 90))
      return sandboxDown
        ? { status: "degraded", sandbox: "unreachable", snapshot_id: SNAPSHOT.snapshot_id }
        : { status: "ok", sandbox: "reachable", snapshot_id: SNAPSHOT.snapshot_id }
    },
  }
}

// ---------------------------------------------------------------- search

const STOP = new Set(["the", "and", "for", "with", "that", "this", "are", "what", "how", "who", "people", "want", "can", "into", "from", "about", "they", "their", "them", "our", "your", "use", "using"])
const SYNONYMS: Record<string, string[]> = {
  code: ["debug", "script", "program", "python", "javascript", "sql", "web", "bot", "api"],
  coding: ["debug", "script", "program", "python", "javascript", "sql"],
  programming: ["debug", "script", "python", "javascript", "sql", "code"],
  bug: ["debug", "error"],
  image: ["midjourney", "diffusion", "prompt", "logo", "visual"],
  art: ["midjourney", "diffusion", "logo", "visual", "image"],
  picture: ["midjourney", "diffusion", "image", "visual"],
  essay: ["academic", "paper", "rewrite", "essay"],
  cheat: ["essay", "exam", "quiz", "human", "detector"],
  detector: ["human", "detector"],
  email: ["email", "translat"],
  translate: ["translat"],
  homework: ["math", "exam", "quiz", "physic", "problem"],
  school: ["math", "exam", "quiz", "essay", "academic"],
  story: ["fiction", "story", "episode", "crossover", "role"],
  fanfic: ["fiction", "episode"],
  roleplay: ["role", "persona"],
  jailbreak: ["persona", "unrestricted", "rule"],
  news: ["real-time", "news", "current"],
  internet: ["real-time", "link", "access"],
  job: ["resume", "cover", "career"],
  marketing: ["marketing", "seo", "social"],
  gpt: ["model", "gpt-4"],
}

function stem(w: string) {
  return w.replace(/(ing|ers|er|ed|es|s)$/u, "")
}

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w))
}

export function searchClusters(query: string) {
  const q = tokens(query.slice(0, 200))
  const expanded = new Set<string>()
  for (const w of q) {
    expanded.add(stem(w))
    for (const s of SYNONYMS[w] ?? SYNONYMS[stem(w)] ?? []) expanded.add(stem(s))
  }
  return SNAPSHOT.clusters.map((c) => {
    const title = tokens(c.title).map(stem)
    const body = tokens([c.description, ...(c.needs ?? []).map((n) => n.text), ...(c.problems ?? []).map((p) => p.text)].join(" ")).map(stem)
    let score = 0
    for (const w of expanded) {
      if (title.some((t) => t.startsWith(w) || w.startsWith(t) && t.length >= 4)) score += 2
      else if (body.some((t) => t.startsWith(w))) score += 1
    }
    const relevance = score >= 2 ? "relevant" : score === 1 ? "unclear" : "not_relevant"
    const p = Math.min(0.98, score === 0 ? 0.04 + Math.random() * 0.08 : 0.42 + score * 0.14)
    return { cluster_id: c.id, relevance, p: Math.round(p * 100) / 100 } as const
  })
}

// ---------------------------------------------------------------- eval

function evalReport(): EvalReport {
  return {
    snapshot_id: SNAPSHOT.snapshot_id,
    generated_at: "2026-09-27T03:31:40Z",
    checks: [
      { id: "cls_agreement", name: "Classification agreement vs independent gold labels", value: "86.5% · κ 0.84", target: "≥ 80%", passed: true, detail: "200-conversation audit sample labelled blind to pipeline output; disagreements concentrated in Writing ↔ Learning." },
      { id: "f1_correction", name: "Friction F1 · correction", value: "0.81", target: "≥ 0.70", passed: true, detail: "Precision 0.84, recall 0.78 on the audit sample (n = 200)." },
      { id: "f1_repeat", name: "Friction F1 · repeated request", value: "0.77", target: "≥ 0.70", passed: true, detail: "Precision 0.80, recall 0.74." },
      { id: "f1_limit", name: "Friction F1 · assistant limit", value: "0.88", target: "≥ 0.70", passed: true, detail: "Precision 0.91, recall 0.85." },
      { id: "f1_complaint", name: "Friction F1 · complaint", value: "0.72", target: "≥ 0.70", passed: true, detail: "Precision 0.69, recall 0.75; sarcasm is the main miss." },
      { id: "canary", name: "Detected canary leaks in browser payloads", value: "0 of 40", target: "0", passed: true, detail: "All 120 canary tokens (names, emails, phones) searched in snapshot, runs, stories and search responses." },
      { id: "injection", name: "Injection-bait fixtures followed", value: "0 of 10", target: "0", passed: true, detail: "Planted conversations asking the model to reveal data or relabel themselves; none changed a label or reached output." },
      { id: "reconcile", name: "Metric reconciliation (sandbox vs trusted reference)", value: `exact · ${SNAPSHOT.clusters.length} leaves, ${SNAPSHOT.categories.length} categories`, target: "exact", passed: true, detail: "Every published count equals the backend reference computed from the same assignments." },
      { id: "gate", name: "Gate rejections of malformed output", value: "12 of 12 rejected", target: "all", passed: true, detail: "Fixture programs with unknown keys, per-person rows, wrong ordering, foreign strings, missing clusters and oversize output." },
      { id: "containment", name: "Sandbox containment", value: "killed at 2,014 ms · removed", target: "≤ 2,500 ms, no orphans", passed: true, detail: "Busy-loop job killed at its deadline; container removed; app healthy; follow-up run passed." },
      { id: "speed", name: "Live analysis time (p50 / p95)", value: "5.8 s / 8.9 s", target: "≤ 15 s", passed: true, detail: "20 runs per question, including one repair round where needed." },
      { id: "truncation", name: "Label drift from transcript truncation", value: "1.9% of labels", target: "report", passed: null, detail: "Full vs truncated rendering on 150 long conversations. Informational; no target." },
    ],
  }
}
