// In-browser mock of the logless API. Runs are Date.now()-driven state
// machines (no timers to clean up); an in-flight analysis for the same
// intent + snapshot is reused, as the contract requires.
//
// §0: the only live intent is "question"; each plan is answered by two
// independently written programs (A: pandas, B: plain Python) whose outputs are
// gated, cross-checked against the published map, and compared.
//
// URL switches for exercising UI states (mock mode only):
//   ?sandbox=down   health degraded, analyses/containment → 503 sandbox_unreachable
//   ?gate=fail      program A keeps failing the gate after its repair; the run fails
//   ?budget=out     live features → 429 budget_exhausted
//   ?snapshot=real  serve src/mocks/real-snapshot.json (a saved copy of the live snapshot)

import { ApiError, type Api } from "@/lib/api"
import type {
  Attempt,
  EvalReport,
  GateCheck,
  Plan,
  QuestionResult,
  Health,
  Receipt,
  Run,
  RunStage,
  RunState,
  Snapshot,
  Subtheme,
  SubthemesResponse,
  StageStatus,
  Story,
  StoryResponse,
  Prd,
  PrdResponse,
  Verdict,
} from "@/lib/types"
import type { Brief, BriefResponse } from "@/video/types"
import snapshotJson from "./snapshot.json"
import { CONTAINMENT_PROGRAM, questionProgram, questionProgramB } from "./programs"
import { consistencyChecks, interpretQuestion, questionExplanation, questionResult } from "./results"
import { mockStory } from "./stories"
import { createIntakeMock } from "./intake"
import { presenterKey } from "@/lib/presenter"
import { canvasSpec, type CanvasCandidate } from "@/lib/canvas"

let SNAPSHOT = snapshotJson as unknown as Snapshot
export const STORY_LABEL = "Fictional user story · Illustrates an aggregate pattern; not a real customer or additional evidence."

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const iso = (ms: number) => new Date(ms).toISOString()
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("")
const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`)

/** Deterministic stand-in sub-themes: each leaf's needs, as unequal slices of the leaf. */
function mockSubthemes(snap: Snapshot, snapshotId: string): SubthemesResponse {
  const leaves: Record<string, Subtheme[]> = {}
  for (const leaf of snap.clusters) {
    const needs = leaf.needs ?? []
    if (leaf.is_other || leaf.conversations < 30 || needs.length < 2) {
      leaves[leaf.id] = []
      continue
    }
    const weights = needs.map((_, i) => 1 / (i + 1.4))
    const rest = Math.max(1, Math.round(leaf.conversations * 0.08))
    const sum = weights.reduce((a, b) => a + b, 0)
    let left = leaf.conversations - rest
    const items: Subtheme[] = needs.map((n, i) => {
      const c = i === needs.length - 1 ? left : Math.round(((leaf.conversations - rest) * weights[i]) / sum)
      left -= c
      return { id: `${leaf.id}_s${i}`, short_title: n.text.split(/\s+/).slice(0, 3).join(" "), conversations: c, users: Math.max(5, Math.round(c * 0.6)) }
    })
    items.push({ id: `${leaf.id}_rest`, short_title: null, conversations: rest, users: Math.max(1, Math.round(rest * 0.7)), rest: true })
    leaves[leaf.id] = items
  }
  return { snapshot_id: snapshotId, base_snapshot_id: snap.snapshot_id, leaves }
}

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
  execution?: number // sandbox executions started by this phase
}

/** A program version, shown in attempts_log once `afterPhase` has finished. */
type LoggedAttempt = { entry: Attempt; afterPhase: number }

type MockRun = {
  id: string
  kind: Run["kind"]
  intent: "question" | null
  question?: string
  plan?: Plan | null
  createdAt: number
  phases: Phase[]
  finalState: "completed" | "failed"
  // question runs (§0): per-program attempt log + combined verdict per validation
  log?: LoggedAttempt[]
  // containment / story runs: single program history
  codes: string[]
  shas: string[]
  receipts: Receipt[]
  verdicts: Verdict[] // combined verdict per validating phase (index = validation count - 1)
  result: QuestionResult | null
  explanation: Run["explanation"]
  containment: Run["containment"]
  error: Run["error"]
  storyClusterId?: string
}

const LIMITS: Receipt["limits"] = { cpus: 1, memory_mb: 512, pids: 64, timeout_s: 10, network: "none", read_only_root: true }
const HOST = "logless-sandbox-ewr"

function receipt(startedAt: number, sha: string, elapsed: number, outputBytes: number, over: Partial<Receipt> = {}): Receipt {
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
    started_at: iso(startedAt),
    finished_at: iso(startedAt + elapsed),
    host: HOST,
    ...over,
  }
}

// Per-program gate checks (CONTRACTS §0 / §8b fixed vocabulary); details never echo values.
function programChecks(rows: number, bytes: number, plan: Plan): GateCheck[] {
  return [
    { name: "Result file received", passed: true, detail: "a result file was produced" },
    { name: "Size within 1 MiB", passed: true, detail: `${bytes.toLocaleString("en-US")} bytes` },
    { name: "Strict JSON parse", passed: true, detail: "one JSON object" },
    { name: "Document within structural limits", passed: true, detail: "depth <= 6, strings <= 64 chars" },
    { name: "Only allowlisted field names", passed: true, detail: "all field names are in the schema" },
    { name: "Only allowlisted string values", passed: true, detail: "only intent, snapshot, plan and node ids" },
    { name: "Schema matches exactly", passed: true, detail: "question result schema, no extra fields" },
    { name: "Plan echoed exactly", passed: true, detail: "all six keys match" },
    { name: "Intent matches the request", passed: true, detail: "matches" },
    { name: "Snapshot id is the current snapshot", passed: true, detail: "matches" },
    { name: "Ids are within the question's scope (no Other)", passed: true, detail: `${rows} ids, all in scope` },
    { name: "Counts are non-negative integers", passed: true, detail: "ok" },
    { name: "Count never exceeds base", passed: true, detail: "ok" },
    { name: "Shares equal count ÷ base within 1e-4", passed: true, detail: "ok" },
    { name: "Row count is min(limit, groups in scope)", passed: true, detail: `${rows} rows` },
    { name: `Top rows ranked as the plan says (${plan.rank_by} desc, then id)`, passed: true, detail: "ok" },
  ]
}

function failCheck(checks: GateCheck[], name: string, detail: string): GateCheck[] {
  return checks.map((c) => (c.name === name ? { ...c, passed: false, detail } : c))
}

const verdictOf = (checks: GateCheck[]): Verdict => ({ passed: checks.every((c) => c.passed), checks })
const prefixed = (p: "A" | "B", checks: GateCheck[]) => checks.map((c) => ({ ...c, name: `${p} · ${c.name}` }))

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
  const inflight = new Map<string, string>() // normalized question + snapshot -> run id
  const storyRuns = new Map<string, string>() // cluster id -> story run id
  const sandboxDown = param("sandbox") === "down"
  const gateFails = param("gate") === "fail"
  const budgetOut = param("budget") === "out"
  const budget = () => new ApiError(429, "budget_exhausted", "Global spend cap reached.")
  const intake = createIntakeMock({
    get: () => SNAPSHOT,
    set: (s) => {
      SNAPSHOT = s
    },
    presenter: () => !!presenterKey(),
    newId: () => `run_${hex(12)}`,
  })

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
    // live backend reports "planning" while the interpreting stage runs
    const state: RunState = finished
      ? r.finalState
      : running
        ? running.state
        : t < r.phases[0].start
          ? "queued"
          : (r.phases.filter((p) => t >= p.end).at(-1)?.state ?? "queued")
    const executions = r.phases.filter((p) => p.execution && t >= p.start).reduce((a, p) => a + (p.execution ?? 0), 0)
    const validations = r.phases.filter((p) => p.name === "validating" && t >= p.end).length
    const verdict = validations ? (r.verdicts[validations - 1] ?? null) : null
    const explained = r.phases.find((p) => p.name === "explaining")

    if (r.kind === "analysis") {
      const log = (r.log ?? []).filter((l) => t >= r.phases[l.afterPhase].end).map((l) => l.entry)
      const latest = log.at(-1)
      return {
        run_id: r.id,
        kind: r.kind,
        intent: r.intent,
        snapshot_id: SNAPSHOT.snapshot_id,
        state,
        created_at: iso(r.createdAt),
        updated_at: iso(Math.min(now, r.createdAt + r.phases[r.phases.length - 1].end)),
        stages,
        attempts: executions,
        code: latest?.code ?? null,
        receipt: latest?.receipt ?? null,
        verdict,
        result: finished || (explained && t >= explained.start) ? (verdict?.passed ? r.result : null) : null,
        explanation: explained && t >= explained.end ? r.explanation : null,
        containment: null,
        error: finished ? r.error : null,
        question: r.question ?? null,
        plan: (() => {
          const interp = r.phases.find((p) => p.name === "interpreting")
          return r.plan && (!interp || t >= interp.end) ? r.plan : null
        })(),
        attempts_log: log,
      }
    }

    return {
      run_id: r.id,
      kind: r.kind,
      intent: null,
      snapshot_id: SNAPSHOT.snapshot_id,
      state,
      created_at: iso(r.createdAt),
      updated_at: iso(Math.min(now, r.createdAt + r.phases[r.phases.length - 1].end)),
      stages,
      attempts: executions,
      code: null,
      receipt: r.receipts.length && t >= r.phases[0].end ? r.receipts[0] : null,
      verdict: r.kind === "containment" && finished ? (r.verdicts[0] ?? null) : null,
      result: null,
      explanation: null,
      containment: finished ? r.containment : null,
      error: finished ? r.error : null,
      question: null,
      plan: null,
      attempts_log: [],
    }
  }

  // Example question that takes the repair path: program A's first version
  // divides by the whole scope, the gate rejects its shares, A is regenerated.
  const REPAIR_QUESTION = /assistant limits most often, as a share/i

  async function newQuestionRun(question: string): Promise<MockRun> {
    const createdAt = Date.now()
    const id = `run_${hex(12)}`
    const interp = interpretQuestion(question, SNAPSHOT)
    const interpreting: Phase = {
      name: "interpreting",
      state: "planning",
      start: 150,
      end: 1350,
      detail: "GLM is mapping the question to a closed-vocabulary plan (it sees titles, not data)",
      doneDetail: "plan" in interp ? "Plan validated against the schema" : "Question can't be expressed as a plan",
      outcome: "plan" in interp ? "done" : "failed",
    }
    const base = { id, kind: "analysis" as const, intent: "question" as const, question, createdAt, codes: [], shas: [], receipts: [], containment: null }

    if ("unsupported" in interp) {
      const skipped = ["planning", "executing", "validating", "explaining"].map(
        (name, i): Phase => ({ name, state: "planning", start: 1350 + i, end: 1351 + i, detail: "", outcome: "skipped" }),
      )
      return {
        ...base, plan: null, phases: [interpreting, ...skipped], finalState: "failed", log: [], verdicts: [], result: null, explanation: null,
        error: { code: "unsupported_question", message: interp.unsupported },
      }
    }

    const plan = interp.plan
    const result = questionResult(SNAPSHOT, plan)
    const bytes = JSON.stringify(result).length
    const okChecks = programChecks(result.rows.length, bytes, plan)
    const consistency = consistencyChecks(SNAPSHOT, result)
    const agree: GateCheck = { name: "Two independent programs agree", passed: true, detail: "identical after canonicalization (shares to 4 dp)" }
    const codeA = questionProgram(plan)
    const codeB = questionProgramB(plan)
    const [shaA, shaB] = await Promise.all([sha256(codeA), sha256(codeB)])
    const repair = gateFails || REPAIR_QUESTION.test(question)
    const T = 1350

    const phases: Phase[] = [
      interpreting,
      { name: "planning", state: "planning", start: T, end: T + 1700, detail: "GLM is writing two programs in parallel: A with pandas, B with plain Python (neither sees data)", doneDetail: "Programs A (pandas) and B (plain Python) written independently · static checks passed" },
    ]
    const log: LoggedAttempt[] = []
    const verdicts: Verdict[] = []
    const eA1 = Math.round(jitter(2300, 2700))
    const eB1 = Math.round(jitter(1900, 2500))

    if (!repair) {
      phases.push(
        { name: "executing", state: "executing", start: T + 1700, end: T + 1700 + Math.max(eA1, eB1) + 250, detail: "Running A and B in separate gVisor containers · no network · read-only root", doneDetail: `A exit 0 in ${eA1.toLocaleString("en-US")} ms · B exit 0 in ${eB1.toLocaleString("en-US")} ms · containers removed`, execution: 2 },
      )
      const e = phases.at(-1)!
      phases.push({ name: "validating", state: "validating", start: e.end, end: e.end + 450, detail: "Gate checks each output, then the published map, then agreement", doneDetail: `A ${okChecks.length}/${okChecks.length} · B ${okChecks.length}/${okChecks.length} · published map ${consistency.length ? `${consistency.length}/${consistency.length}` : "not derivable"} · programs agree` })
      const v = phases.length - 1
      log.push(
        { entry: { attempt: 1, program: "A", code: codeA, code_sha256: shaA, receipt: receipt(createdAt + e.start + 100, shaA, eA1, bytes), verdict: verdictOf(okChecks), repair_reason: null }, afterPhase: v },
        { entry: { attempt: 1, program: "B", code: codeB, code_sha256: shaB, receipt: receipt(createdAt + e.start + 120, shaB, eB1, bytes), verdict: verdictOf(okChecks), repair_reason: null }, afterPhase: v },
      )
      verdicts.push(verdictOf([...prefixed("A", okChecks), ...prefixed("B", okChecks), ...consistency, agree]))
    } else {
      // attempt 1: A's shares are wrong (whole-scope denominator); B passes
      const badA = questionProgram(plan, true)
      const shaBadA = await sha256(badA)
      const failName = "Shares equal count ÷ base within 1e-4"
      const aFail = failCheck(okChecks, failName, "rows[0].share (+4 more)")
      phases.push({ name: "executing", state: "executing", start: T + 1700, end: T + 1700 + Math.max(eA1, eB1) + 250, detail: "Running A and B in separate gVisor containers · no network · read-only root", doneDetail: `A exit 0 in ${eA1.toLocaleString("en-US")} ms · B exit 0 in ${eB1.toLocaleString("en-US")} ms`, execution: 2 })
      let e = phases.at(-1)!
      phases.push({ name: "validating", state: "validating", start: e.end, end: e.end + 450, detail: "Gate checks each output, then the published map, then agreement", doneDetail: `A rejected: ${failName} · B passed ${okChecks.length}/${okChecks.length}`, outcome: "failed" })
      const v1 = phases.length - 1
      log.push(
        { entry: { attempt: 1, program: "A", code: badA, code_sha256: shaBadA, receipt: receipt(createdAt + e.start + 100, shaBadA, eA1, bytes), verdict: verdictOf(aFail), repair_reason: `Gate check failed: ${failName}` }, afterPhase: v1 },
        { entry: { attempt: 1, program: "B", code: codeB, code_sha256: shaB, receipt: receipt(createdAt + e.start + 120, shaB, eB1, bytes), verdict: verdictOf(okChecks), repair_reason: null }, afterPhase: v1 },
      )
      verdicts.push(verdictOf([...prefixed("A", aFail), ...prefixed("B", okChecks)]))
      const vEnd = phases[v1].end
      phases.push({ name: "repairing", state: "repairing", start: vEnd, end: vEnd + 1500, detail: "GLM is regenerating program A from the failed check name only (B is kept)", doneDetail: `Program A regenerated for: ${failName}` })
      const eA2 = Math.round(jitter(2300, 2700))
      const rEnd = phases.at(-1)!.end
      phases.push({ name: "executing", state: "executing", start: rEnd, end: rEnd + eA2 + 250, detail: "Re-running program A in a fresh gVisor container", doneDetail: `A exit 0 in ${eA2.toLocaleString("en-US")} ms · container removed`, execution: 1 })
      e = phases.at(-1)!
      phases.push({ name: "validating", state: "validating", start: e.end, end: e.end + 450, detail: "Gate checks A, then the published map, then agreement", doneDetail: gateFails ? `A rejected again: ${failName} · run stopped` : `A ${okChecks.length}/${okChecks.length} · published map ${consistency.length ? `${consistency.length}/${consistency.length}` : "not derivable"} · programs agree`, outcome: gateFails ? "failed" : "done" })
      const v2 = phases.length - 1
      const a2 = gateFails ? badA : codeA
      const sha2 = gateFails ? shaBadA : shaA
      log.push({ entry: { attempt: 2, program: "A", code: a2, code_sha256: sha2, receipt: receipt(createdAt + e.start + 100, sha2, eA2, bytes), verdict: verdictOf(gateFails ? aFail : okChecks), repair_reason: gateFails ? `Gate check failed: ${failName}` : null }, afterPhase: v2 })
      verdicts.push(verdictOf(gateFails ? [...prefixed("A", aFail), ...prefixed("B", okChecks)] : [...prefixed("A", okChecks), ...prefixed("B", okChecks), ...consistency, agree]))
    }
    if (!gateFails) {
      const last = phases.at(-1)!.end
      phases.push({ name: "explaining", state: "explaining", start: last, end: last + 1900, detail: "GLM is describing the verified result with placeholders only", doneDetail: "model text validated (placeholders only, no digits)" })
    }
    return {
      ...base, plan, phases, finalState: gateFails ? "failed" : "completed", log, verdicts,
      result: gateFails ? null : result,
      explanation: gateFails ? null : questionExplanation(result),
      error: gateFails ? { code: "gate_rejected", message: "Program A's output failed the gate after one repair, so nothing was released." } : null,
    }
  }

  async function newContainment(): Promise<MockRun> {
    const createdAt = Date.now()
    const elapsed = 2000 + Math.round(jitter(9, 19))
    const phases: Phase[] = [
      { name: "runaway", state: "executing", start: 150, end: 150 + elapsed + 60, detail: "Busy-loop program running · deadline 2,000 ms", doneDetail: `Deadline reached · killed at ${elapsed.toLocaleString("en-US")} ms`, outcome: "failed", execution: 1 },
      { name: "cleanup", state: "executing", start: 150 + elapsed + 60, end: 150 + elapsed + 420, detail: "Supervisor removing the container", doneDetail: "Container removed · no orphans with the job label" },
      { name: "health", state: "validating", start: 150 + elapsed + 420, end: 150 + elapsed + 700, detail: "Checking app and runner health", doneDetail: "App health ok · runner accepting jobs" },
      { name: "destructive", state: "executing", start: 150 + elapsed + 700, end: 150 + elapsed + 1900, detail: "Running rm -rf --no-preserve-root / in a fresh sandbox", doneDetail: "exit 1 · read-only root, binaries intact · container removed · next run clean" },
      { name: "followup", state: "validating", start: 150 + elapsed + 1900, end: 150 + elapsed + 3050, detail: "Running a normal job in a fresh sandbox", doneDetail: "exit 0 · gate passed 16/16 checks" },
      { name: "leak_attempt", state: "validating", start: 150 + elapsed + 3050, end: 150 + elapsed + 4100, detail: "A program tries to export one row per person", doneDetail: "gate rejected the per-user rows: Only allowlisted field names, Schema matches exactly", outcome: "done" },
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
        verdictOf([
          { name: "Result file received", passed: true, detail: "a result file was produced" },
          { name: "Size within 1 MiB", passed: true, detail: "999 bytes" },
          { name: "Strict JSON parse", passed: true, detail: "one JSON object" },
          { name: "Document within structural limits", passed: true, detail: "depth <= 6, strings <= 64 chars" },
          { name: "Only allowlisted field names", passed: false, detail: "unknown field 'user' in rows[0]; unknown field 'user' in rows[1] (+18 more)" },
          { name: "Only allowlisted string values", passed: true, detail: "only intent, snapshot and cluster ids" },
          { name: "Schema matches exactly", passed: false, detail: "missing field at rows[0].share; missing field at rows[0].users (+97 more)" },
        ]),
      ],
      result: null, explanation: null,
      containment: {
        destructive: {
          command: "rm -rf --no-preserve-root /", exit_code: 1, refused: 11089, container_removed: true,
          root_read_only: true, binaries_intact: true, next_run_clean: true, contained: true,
        },
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

    async getSubthemes(snapshotId) {
      await sleep(jitter(120, 240))
      return mockSubthemes(SNAPSHOT, snapshotId)
    },

    async search(req) {
      const t0 = performance.now()
      await sleep(jitter(160, 320))
      const results = searchClusters(req.query)
      return { snapshot_id: req.snapshot_id, query: req.query, results, elapsed_ms: Math.round(performance.now() - t0) }
    },

    async startAnalysis({ intent, snapshot_id, question }) {
      await sleep(jitter(60, 140))
      // §0: question is the only live intent
      if ((intent as string) !== "question") throw new ApiError(422, "invalid_request", 'intent must be "question"')
      if (!question || !question.trim() || question.length > 200) throw new ApiError(422, "invalid_request", "question must be 1–200 characters")
      if (budgetOut) throw budget()
      if (sandboxDown) throw unreachable()
      if (snapshot_id !== SNAPSHOT.snapshot_id) throw new ApiError(409, "stale_snapshot", "This snapshot is no longer current. Reload to see the latest one.")
      const key = `${question.trim().toLowerCase().replace(/\s+/g, " ")}:${snapshot_id}`
      const existing = inflight.get(key)
      if (existing) {
        const r = runs.get(existing)
        if (r && !isFinished(r)) return { run_id: existing }
      }
      const run = await newQuestionRun(question.trim().replace(/\s+/g, " "))
      runs.set(run.id, run)
      inflight.set(key, run.id)
      return { run_id: run.id }
    },

    async composeCanvas(req) {
      await sleep(450)
      if (budgetOut) throw budget()
      if (req.snapshot_id !== SNAPSHOT.snapshot_id) throw new ApiError(409, "stale_snapshot", "Reload the current snapshot.")
      const stored = runs.get(req.run_id)
      if (!stored || toRun(stored).state !== "completed" || !stored.result || !toRun(stored).verdict?.passed) {
        throw new ApiError(409, "unverified_result", "A checked answer is required.")
      }
      const q = (req.instruction || stored.question || "").toLowerCase()
      if (req.instruction && /last week|last month|only health|new topic|rank by|count people/.test(q)) {
        const selected = req.previous.length ? req.previous : ["ranking" as const]
        return { run_id: req.run_id, snapshot_id: req.snapshot_id, status: "needs_analysis", selected, spec: canvasSpec(selected) }
      }
      const ids = new Set(stored.result.rows.map((r) => r.id))
      const available = SNAPSHOT.clusters.filter((n) => ids.has(n.id) || (n.parent_id && ids.has(n.parent_id)))
      let selected: CanvasCandidate[] = req.previous.length ? [...req.previous] : ["ranking"]
      if (/only|just the|ranked bars/.test(q)) selected = ["ranking"]
      else if (/need|gap|problem.*first/.test(q) && available.some((n) => n?.needs?.length || n?.problems?.length)) selected = ["needs", "ranking"]
      else if (/friction|frustrat|signal|complaint/.test(q)) selected = /signal.*first/.test(q) ? ["signals", "friction"] : ["friction", "signals"]
      else if (/card|what.*us.*for/.test(q)) selected = ["cards"]
      return { run_id: req.run_id, snapshot_id: req.snapshot_id, status: "mock", selected, spec: canvasSpec(selected) }
    },

    async getRun(runId) {
      await sleep(jitter(30, 80))
      const ir = intake.run(runId)
      if (ir) return ir
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

    async getBrief(): Promise<BriefResponse> {
      await sleep(jitter(200, 300))
      const sample = (await import("../video/sample-brief.json")).default as unknown as Brief
      return { status: "ready", brief: sample }
    },

    async requestBrief(): Promise<BriefResponse> {
      await sleep(jitter(400, 600))
      const sample = (await import("../video/sample-brief.json")).default as unknown as Brief
      return { status: "ready", brief: sample }
    },

    async requestPrd(clusterId, snapshotId): Promise<PrdResponse> {
      await sleep(jitter(600, 1200))
      if (budgetOut) throw budget()
      const node = SNAPSHOT.clusters.find((c) => c.id === clusterId)
      if (!node) throw new ApiError(404, "not_found", "Cluster not found.")
      const need = node.needs?.[0]
      const prob = node.problems?.[0]
      const fs = `${((node.friction.share ?? 0) * 100).toFixed(1)}%`
      const prd: Prd = {
        cluster_id: clusterId,
        snapshot_id: snapshotId,
        label: "Draft PRD · mock data",
        title: `Reduce friction in ${node.short_title ?? node.title}`,
        problem: `${fs} of ${node.conversations.toLocaleString("en-US")} conversations show friction${prob ? ` [${prob.id}]` : ""}.`,
        user_stories: [`As a user, I want ${need?.text.toLowerCase() ?? "a reliable answer"} so that I can finish my task${need ? ` [${need.id}]` : ""}.`],
        requirements: [`Address the top problem first${prob ? ` [${prob.id}]` : ""}.`],
        success_metrics: [`Friction share drops from ${fs}.`],
        citations: [need?.id, prob?.id].filter((x): x is string => !!x),
        metrics_used: [{ name: "friction_share", value: fs }],
        priority: { level: "P1", rank: 6, of: 30, basis: "Mock priority." },
        model: "glm-5.3",
        generated_at: new Date().toISOString(),
      }
      return { status: "ready", prd }
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

    async getIntakeStatus() {
      await sleep(jitter(40, 90))
      return intake.status()
    },

    async startIntake() {
      await sleep(jitter(60, 120))
      const res = intake.start()
      if ("error" in res) throw new ApiError(...res.error)
      return res
    },

    async getIntakeEvents(runId, after) {
      await sleep(jitter(20, 60))
      const res = intake.events(runId, after)
      if (!res) throw new ApiError(404, "not_found", "Run not found.")
      return res
    },

    async resetIntake() {
      await sleep(jitter(80, 160))
      const res = intake.reset()
      if ("error" in res) throw new ApiError(...res.error)
      return res
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
