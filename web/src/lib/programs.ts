// §0: every question is answered by two independently written programs
// (A: pandas, B: plain Python). These helpers group a run's attempt log and
// verdict into per-program tracks and cross-checks, reading only what the run
// carries (older single-program runs have no `program` field).
import type { Attempt, GateCheck, ProgramId, Run } from "./types"

export const PROGRAM_KIND: Record<ProgramId, string> = { A: "pandas", B: "plain Python" }
export const PROGRAM_KIND_LONG: Record<ProgramId, string> = {
  A: "pandas",
  B: "standard library only (csv, json, collections)",
}

/** A missing receipt alone does not establish whether the runner started. */
export function missingReceiptCopy(attempt: Pick<Attempt, "verdict">) {
  const failed = attempt.verdict.checks.filter((check) => check.passed === false)
  const execution = failed.find((check) => check.name === "Execution evidence")
  if (execution && /^job did not start(?: \([a-z_]+\))?$/.test(execution.detail)) {
    return {
      label: "not started",
      message: "Runner did not start the job.",
      repairLabel: "was not started by the runner",
    }
  }
  if (!execution && failed.some((check) => check.name === "Static pre-check")) {
    return {
      label: "pre-check",
      message: "Static pre-check rejected the program before it reached the sandbox.",
      repairLabel: "was stopped by the static pre-check",
    }
  }
  return {
    label: "no execution receipt",
    message: "No execution receipt is available; execution status is unknown.",
    repairLabel: "has no execution receipt",
  }
}

export type ProgramTrack = {
  program: ProgramId
  attempts: Attempt[]
  latest: Attempt
  /** more than one version of this program exists */
  repaired: boolean
}

/** Per-program attempt tracks in A, B order. Attempts without `program` count as A. */
export function programTracks(run: Pick<Run, "attempts_log"> | null): ProgramTrack[] {
  const log = run?.attempts_log ?? []
  const by = new Map<ProgramId, Attempt[]>()
  for (const a of log) {
    const p = a.program ?? "A"
    by.set(p, [...(by.get(p) ?? []), a])
  }
  return (["A", "B"] as const)
    .filter((p) => by.has(p))
    .map((p) => {
      const attempts = by.get(p)!
      return { program: p, attempts, latest: attempts[attempts.length - 1], repaired: attempts.length > 1 }
    })
}

/** True when the run reports the two-program design (any attempt carries `program`). */
export function isTwoProgram(run: Pick<Run, "attempts_log"> | null): boolean {
  return (run?.attempts_log ?? []).some((a) => !!a.program)
}

const PREFIX = /^\s*(?:program\s+)?([AB])\s*(?:[·:\-–—]|\))\s*/i

/** "A · Schema matches exactly" → { program: "A", name: "Schema matches exactly" } */
export function splitProgramPrefix(name: string): { program: ProgramId | null; name: string } {
  const m = PREFIX.exec(name)
  return m ? { program: m[1].toUpperCase() as ProgramId, name: name.slice(m[0].length) } : { program: null, name }
}

export type CrossChecks = {
  /** checks against the published snapshot (derivable only for some plans) */
  consistency: GateCheck[]
  /** "Two independent programs agree" */
  agreement: GateCheck | null
  /** any other run-level check that isn't per-program */
  other: GateCheck[]
}

const AGREE = /agree|disagree|identical/i
const CONSISTENT = /published|consisten|snapshot map|\bmap\b/i

/**
 * Splits `Run.verdict.checks` into run-level cross-checks. Per-program checks
 * are recognised by an "A ·"/"B:" prefix or by appearing in a program's own
 * latest verdict, and are left out here (they belong to that program's track).
 */
export function crossChecks(run: Pick<Run, "verdict" | "attempts_log"> | null): CrossChecks {
  const out: CrossChecks = { consistency: [], agreement: null, other: [] }
  const checks = run?.verdict?.checks ?? []
  const perProgram = new Set<string>()
  for (const t of programTracks(run)) for (const c of t.latest.verdict.checks) perProgram.add(c.name)
  for (const c of checks) {
    const { program, name } = splitProgramPrefix(c.name)
    if (program) continue
    if (AGREE.test(name)) out.agreement = c
    else if (CONSISTENT.test(name) && !perProgram.has(name)) out.consistency.push(c)
    else if (!perProgram.has(name)) out.other.push(c)
  }
  return out
}

export type Repair = { program: ProgramId; failed: Attempt; reason: string | null }

/** Every program version that did not pass and was followed by a newer version. */
export function repairs(run: Pick<Run, "attempts_log"> | null): Repair[] {
  const out: Repair[] = []
  for (const t of programTracks(run)) {
    t.attempts.forEach((a, i) => {
      if (i < t.attempts.length - 1 && !a.verdict.passed) out.push({ program: t.program, failed: a, reason: a.repair_reason })
    })
  }
  return out
}

/** Passed/total over the programs' latest per-program checks. */
export function programGateTally(run: Pick<Run, "attempts_log"> | null): { passed: number; total: number } | null {
  const tracks = programTracks(run)
  if (!tracks.length) return null
  let passed = 0
  let total = 0
  for (const t of tracks) {
    total += t.latest.verdict.checks.length
    passed += t.latest.verdict.checks.filter((c) => c.passed).length
  }
  return { passed, total }
}
