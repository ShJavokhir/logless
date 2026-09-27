import { describe, expect, it } from "vitest"
import { arcControl, bezier, createIntakeScheduler, flightMs, formatDelta, pickToastDeltas, stageStates } from "./intake"

const ev = (seq: number, t_ms: number) => ({ seq, t_ms })

describe("createIntakeScheduler", () => {
  it("keeps the real pacing between events, after a small lead", () => {
    const s = createIntakeScheduler({ leadMs: 400 })
    s.push([ev(1, 100), ev(2, 350)], 1000)
    expect(s.tick(1399).spawn).toHaveLength(0)
    expect(s.tick(1400).spawn.map((e) => e.seq)).toEqual([1])
    expect(s.tick(1649).spawn).toHaveLength(0)
    expect(s.tick(1650).spawn.map((e) => e.seq)).toEqual([2])
  })

  it("never has more than maxActive dots in flight; land() frees a slot", () => {
    const s = createIntakeScheduler({ leadMs: 0, maxActive: 2, maxLagMs: 10_000 })
    s.push([ev(1, 0), ev(2, 0), ev(3, 0)], 0)
    expect(s.tick(0).spawn.map((e) => e.seq)).toEqual([1, 2])
    expect(s.active).toBe(2)
    expect(s.tick(10).spawn).toHaveLength(0)
    s.land()
    expect(s.tick(20).spawn.map((e) => e.seq)).toEqual([3])
  })

  it("files overdue events instantly when rendering falls behind", () => {
    const s = createIntakeScheduler({ leadMs: 0, maxActive: 1, maxLagMs: 500 })
    s.push([ev(1, 0), ev(2, 0)], 0)
    expect(s.tick(0).spawn).toHaveLength(1)
    const later = s.tick(600)
    expect(later.spawn).toHaveLength(0)
    expect(later.instant.map((e) => e.seq)).toEqual([2])
    expect(s.pending).toBe(0)
  })

  it("with reduced motion files everything without dots", () => {
    const s = createIntakeScheduler({ reducedMotion: true, leadMs: 0 })
    s.push([ev(1, 0), ev(2, 5)], 0)
    const t = s.tick(10)
    expect(t.spawn).toHaveLength(0)
    expect(t.instant.map((e) => e.seq)).toEqual([1, 2])
    expect(s.drained).toBe(true)
  })

  it("keeps seq order, ignores duplicates, and clamps late batches to now", () => {
    const s = createIntakeScheduler({ leadMs: 0, maxActive: 99 })
    s.push([ev(2, 10), ev(1, 0)], 0)
    s.push([ev(2, 10)], 5) // duplicate from an overlapping poll
    s.push([ev(3, 0)], 5000) // arrived late: due now, not in the past
    expect(s.tick(10).spawn.map((e) => e.seq)).toEqual([1, 2])
    expect(s.tick(4999).spawn).toHaveLength(0)
    expect(s.tick(5000).spawn.map((e) => e.seq)).toEqual([3])
    expect(s.drained).toBe(false)
    s.land()
    s.land()
    s.land()
    expect(s.drained).toBe(true)
  })
})

describe("flight geometry", () => {
  it("starts and ends on the endpoints and bends to one side", () => {
    const a = { x: 0, y: 0 }
    const b = { x: 100, y: 0 }
    const c = arcControl(a, b)
    expect(bezier(a, c, b, 0)).toEqual(a)
    expect(bezier(a, c, b, 1)).toEqual(b)
    expect(bezier(a, c, b, 0.5).y).toBeLessThan(0)
    expect(flightMs(a, b)).toBeGreaterThanOrEqual(850)
    expect(flightMs(a, { x: 5000, y: 0 })).toBe(1500)
  })
})

describe("stages and deltas", () => {
  it("derives stage states from the current stage", () => {
    expect(stageStates("filing", "running")).toEqual(["done", "running", "pending", "pending", "pending"])
    expect(stageStates("done", "completed")).toEqual(["done", "done", "done", "done", "done"])
    expect(stageStates("gating", "failed")).toEqual(["done", "done", "failed", "pending", "pending"])
    expect(stageStates(null, null).every((s) => s === "pending")).toBe(true)
  })

  it("formats deltas with the friction change only when it moved", () => {
    const names: Record<string, string> = { cl_a: "Fixing errors" }
    const d = { id: "cl_a", conversations_before: 129, conversations_after: 141, friction_share_before: 0.3953, friction_share_after: 0.4014 }
    expect(formatDelta(d, (id) => names[id])).toBe("Fixing errors: 129 → 141 conversations · friction 39.5% → 40.1%")
    expect(formatDelta({ ...d, friction_share_after: 0.3953 }, (id) => names[id])).toBe("Fixing errors: 129 → 141 conversations")
    expect(formatDelta({ ...d, friction_share_before: null }, () => undefined)).toBe("cl_a: 129 → 141 conversations")
  })

  it("picks leaf deltas with the largest gains, never Other", () => {
    const mk = (id: string, gain: number) => ({ id, conversations_before: 100, conversations_after: 100 + gain, friction_share_before: 0.1, friction_share_after: 0.1 })
    const picked = pickToastDeltas([mk("cat_x", 90), mk("cl_other", 50), mk("cl_a", 10), mk("cl_b", 30), mk("cl_c", 20)], 2)
    expect(picked.map((d) => d.id)).toEqual(["cl_b", "cl_c"])
  })
})

describe("pickInboxCorner", () => {
  it("chooses the corner the badge overlaps least, top-left on ties", async () => {
    const { pickInboxCorner } = await import("./intake")
    expect(pickInboxCorner([], 800, 600).corner).toBe("top-left")
    // a circle filling the top-left pushes the inbox elsewhere
    const busy = pickInboxCorner([{ x: 60, y: 40, r: 80 }], 800, 600)
    expect(busy.corner).toBe("top-right")
    expect(busy.left).toBeGreaterThan(500)
    expect(busy.origin.x).toBe(busy.left + 16)
  })
})
