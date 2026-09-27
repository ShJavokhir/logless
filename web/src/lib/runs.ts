import type { Run, RunStage, StageStatus } from "./types"
import { durationMs } from "./format"

export type StepKey = "interpreting" | "planning" | "executing" | "validating" | "repairing" | "explaining"
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped"
export type Step = { key: StepKey; label: string; status: StepStatus; detail: string | null; count: number }

const STEP_LABEL: Record<StepKey, string> = {
  interpreting: "Interpreting",
  planning: "Planning",
  executing: "Executing in sandbox",
  validating: "Validating",
  repairing: "Repairing",
  explaining: "Explaining",
}

/**
 * Collapses a run's stage list into the canonical stepper. Each step takes the
 * status of the latest stage of that name that has started; "Repairing" only
 * appears when the run actually repaired (a repairing stage or attempts ≥ 2).
 */
export function deriveSteps(
  run: (Pick<Run, "stages" | "attempts" | "state"> & { intent?: Run["intent"]; attempts_log?: Run["attempts_log"] }) | null,
  forQuestion = false,
): Step[] {
  const stages = run?.stages ?? []
  // A static pre-check rejection can yield two program versions with one execution.
  const repaired = stages.some((s) => s.name === "repairing") || (run?.attempts ?? 0) >= 2 || (run?.attempts_log?.length ?? 0) >= 2
  const interprets = forQuestion || run?.intent === "question" || stages.some((s) => s.name === "interpreting")
  const keys: StepKey[] = [
    ...(interprets ? (["interpreting"] as const) : []),
    "planning",
    "executing",
    "validating",
    ...(repaired ? (["repairing"] as const) : []),
    "explaining",
  ]
  return keys.map((key) => {
    const same = stages.filter((s) => s.name === key)
    const started = same.filter((s) => s.status !== "pending")
    const latest = started[started.length - 1]
    let status: StepStatus = latest ? (latest.status as StepStatus) : "pending"
    if (!latest && run?.state === "failed") status = "skipped"
    if (!latest && key === "repairing" && repaired && (run?.attempts ?? 0) >= 2) status = "done"
    return { key, label: STEP_LABEL[key], status, detail: latest?.detail ?? null, count: started.length }
  })
}

export function currentStage(run: Run | null): RunStage | null {
  return run?.stages.find((s) => s.status === "running") ?? null
}

export function isRunActive(run: Run | null | undefined): boolean {
  return !!run && run.state !== "completed" && run.state !== "failed"
}

/** Wall-clock duration of a run from its first stage start to last finish. */
export function runDurationMs(run: Run | null): number | null {
  if (!run) return null
  const starts = run.stages.map((s) => s.started_at).filter((x): x is string => !!x)
  const ends = run.stages.map((s) => s.finished_at).filter((x): x is string => !!x)
  if (!starts.length || !ends.length) return null
  return durationMs(starts[0], ends[ends.length - 1])
}

const STAGE_NAMES: Record<string, string> = {
  queued: "Queued",
  interpreting: "Interpreting",
  planning: "Planning",
  executing: "Executing in sandbox",
  validating: "Egress gate",
  repairing: "Repairing",
  explaining: "Explaining",
  writing: "Writing story",
  checking: "Privacy check",
  runaway: "Runaway program",
  cleanup: "Cleanup",
  health: "Health check",
  destructive: "Destructive command",
  followup: "Follow-up run",
  leak_attempt: "Leak attempt",
}

export function stageLabel(name: string): string {
  return STAGE_NAMES[name] ?? name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
}

export function statusTone(status: StageStatus | StepStatus): "muted" | "live" | "ok" | "bad" {
  if (status === "running") return "live"
  if (status === "done") return "ok"
  if (status === "failed") return "bad"
  return "muted"
}
