// §11 live intake: pure helpers for pacing events into animations, flight
// geometry, stage progress and completion copy. No DOM, no timers.
import type { IntakeDelta, IntakeEvent, IntakeStage } from "./types"
import { fmtInt, fmtPct } from "./format"

// ---------------------------------------------------------------- scheduler

export type SchedulerOptions = {
  /** delay between an event's decision time and its dot leaving the inbox */
  leadMs?: number
  /** most dots in flight at once; extra due events wait for a slot */
  maxActive?: number
  /** events overdue by more than this are filed instantly (no dot) to catch up */
  maxLagMs?: number
  /** prefers-reduced-motion: never spawn dots, file everything instantly */
  reducedMotion?: boolean
}

export type Tick<E> = { spawn: E[]; instant: E[] }

/**
 * Paces events by their own `t_ms` so dots leave the inbox at the real
 * decision rate (anchored to wall-clock on the first push), with a cap on dots
 * in flight and a catch-up rule when rendering falls behind.
 */
export function createIntakeScheduler<E extends Pick<IntakeEvent, "seq" | "t_ms">>(opts: SchedulerOptions = {}) {
  const { leadMs = 400, maxActive = 60, maxLagMs = 1500, reducedMotion = false } = opts
  let anchor: number | null = null
  let active = 0
  const seen = new Set<number>()
  let pending: { ev: E; due: number }[] = []

  return {
    push(events: E[], now: number) {
      for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
        if (seen.has(ev.seq)) continue
        seen.add(ev.seq)
        if (anchor === null) anchor = now + leadMs - ev.t_ms
        pending.push({ ev, due: Math.max(anchor + ev.t_ms, now) })
      }
      pending.sort((a, b) => a.due - b.due || a.ev.seq - b.ev.seq)
    },
    tick(now: number): Tick<E> {
      const out: Tick<E> = { spawn: [], instant: [] }
      const keep: { ev: E; due: number }[] = []
      for (const item of pending) {
        if (item.due > now) {
          keep.push(item)
        } else if (reducedMotion) {
          out.instant.push(item.ev)
        } else if (active < maxActive) {
          active++
          out.spawn.push(item.ev)
        } else if (now - item.due > maxLagMs) {
          out.instant.push(item.ev)
        } else {
          keep.push(item)
        }
      }
      pending = keep
      return out
    },
    /** a dot reached its circle */
    land() {
      active = Math.max(0, active - 1)
    },
    get active() {
      return active
    },
    get pending() {
      return pending.length
    },
    /** nothing waiting and nothing in flight */
    get drained() {
      return pending.length === 0 && active === 0
    },
    reset() {
      anchor = null
      active = 0
      pending = []
      seen.clear()
    },
  }
}

export type IntakeScheduler<E extends Pick<IntakeEvent, "seq" | "t_ms">> = ReturnType<typeof createIntakeScheduler<E>>

// ---------------------------------------------------------------- flight geometry

export type Pt = { x: number; y: number }

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

export function bezier(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y }
}

/** Control point bending every flight the same way (calm, consistent arcs). */
export function arcControl(from: Pt, to: Pt, bend = 0.28): Pt {
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  const dx = to.x - from.x
  const dy = to.y - from.y
  // perpendicular, always to the same side (clockwise)
  return { x: mx + dy * bend, y: my - dx * bend }
}

/** Flight time grows gently with distance. */
export function flightMs(from: Pt, to: Pt): number {
  const d = Math.hypot(to.x - from.x, to.y - from.y)
  return Math.round(Math.min(1500, Math.max(850, 700 + d * 0.9)))
}

// ---------------------------------------------------------------- stages & copy

export const INTAKE_STAGES: { key: Exclude<IntakeStage, "done">; label: string }[] = [
  { key: "deciding", label: "Deciding with Jev" },
  { key: "filing", label: "Filing" },
  { key: "gating", label: "Privacy gate" },
  { key: "publishing", label: "Publishing" },
  { key: "evaluating", label: "Eval" },
]

export type StageState = "pending" | "running" | "done" | "failed"

export function stageStates(stage: IntakeStage | null, runState: "running" | "completed" | "failed" | null): StageState[] {
  const idx = stage === "done" ? INTAKE_STAGES.length : stage ? INTAKE_STAGES.findIndex((s) => s.key === stage) : -1
  return INTAKE_STAGES.map((_, i) => {
    if (runState === "completed" && stage === "done") return "done"
    if (i < idx) return "done"
    if (i === idx) return runState === "failed" ? "failed" : runState === "completed" && stage !== "evaluating" ? "done" : "running"
    return "pending"
  })
}

/** "Fixing errors: 129 → 141 conversations · friction 39.5% → 40.1%" */
export function formatDelta(d: IntakeDelta, nameOf: (id: string) => string | undefined): string {
  const name = nameOf(d.id) ?? d.id
  const parts = [`${fmtInt(d.conversations_before)} → ${fmtInt(d.conversations_after)} conversations`]
  const fb = d.friction_share_before
  const fa = d.friction_share_after
  if (fb !== null && fa !== null && Math.abs(fa - fb) >= 0.0005) parts.push(`friction ${fmtPct(fb)} → ${fmtPct(fa)}`)
  return `${name}: ${parts.join(" · ")}`
}

/** The few deltas worth a toast: largest conversation gains first, leaves before categories. */
export function pickToastDeltas(deltas: IntakeDelta[], n = 3): IntakeDelta[] {
  const size = (d: IntakeDelta) => Math.abs(d.conversations_after - d.conversations_before)
  const leafFirst = (d: IntakeDelta) => (d.id.startsWith("cl_") ? 0 : 1)
  return [...deltas]
    .filter((d) => d.id !== "cl_other")
    .sort((a, b) => leafFirst(a) - leafFirst(b) || size(b) - size(a) || a.id.localeCompare(b.id))
    .slice(0, n)
}

export function observedSignals(ev: Pick<IntakeEvent, "friction">): string[] {
  return Object.entries(ev.friction)
    .filter(([, v]) => v === "observed")
    .map(([k]) => k)
}

// ---------------------------------------------------------------- inbox placement

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right"

/**
 * Puts the "new conversations" inbox in the map corner its badge overlaps
 * least (circles are screen-space {x, y, r}); dots start at the badge's icon.
 */
export function pickInboxCorner(
  circles: { x: number; y: number; r: number }[],
  width: number,
  height: number,
  badgeW = 210,
  badgeH = 28,
  inset = 10,
): { corner: Corner; left: number; top: number; origin: Pt } {
  const corners: Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"]
  let best: { corner: Corner; left: number; top: number; score: number } | null = null
  for (const corner of corners) {
    const left = corner.endsWith("left") ? inset : Math.max(inset, width - badgeW - inset)
    const top = corner.startsWith("top") ? inset : Math.max(inset, height - badgeH - inset - 24) // leave room for the legend line
    let score = 0
    for (const c of circles) {
      const nx = Math.max(left, Math.min(c.x, left + badgeW))
      const ny = Math.max(top, Math.min(c.y, top + badgeH))
      const d = Math.hypot(c.x - nx, c.y - ny)
      if (d < c.r) score += c.r - d
    }
    if (!best || score < best.score - 1e-6) best = { corner, left, top, score }
  }
  const b = best!
  return { corner: b.corner, left: b.left, top: b.top, origin: { x: b.left + 16, y: b.top + badgeH / 2 } }
}
