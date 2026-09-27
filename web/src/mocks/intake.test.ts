import { describe, expect, it } from "vitest"
import type { Snapshot } from "@/lib/types"
import { SIGNALS } from "@/lib/types"
import realJson from "./real-snapshot.json"
import { applyIntake, generateIntakeEvents, intakeDeltas } from "./intake"

const s = realJson as unknown as Snapshot

describe("mock intake stream (§11 shape)", () => {
  const events = generateIntakeEvents(s, 7)

  it("emits 300 ordered events at a plausible pace", () => {
    expect(events).toHaveLength(300)
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBe(events[i - 1].seq + 1)
      expect(events[i].t_ms).toBeGreaterThanOrEqual(events[i - 1].t_ms)
    }
    const rate = events.length / (events[events.length - 1].t_ms / 1000)
    expect(rate).toBeGreaterThan(30)
    expect(rate).toBeLessThan(65)
  })

  it("uses published leaf ids, sends low-confidence to Other, and carries no ids or raw text", () => {
    const leafIds = new Set(s.clusters.map((c) => c.id))
    for (const e of events) {
      expect(leafIds.has(e.leaf_id)).toBe(true)
      if (e.leaf_id === "cl_other") expect(e.p).toBeLessThan(0.65)
      else expect(e.p).toBeGreaterThanOrEqual(0.65)
      expect(e.summary === null || e.summary.length <= 90).toBe(true)
      expect(Object.keys(e).sort()).toEqual(["friction", "language", "leaf_id", "p", "seq", "summary", "t_ms", "turns"])
    }
    const friction = events.filter((e) => SIGNALS.some((sig) => e.friction[sig] === "observed")).length / events.length
    expect(friction).toBeGreaterThan(0.1)
    expect(friction).toBeLessThan(0.32)
  })

  it("publishes base + batch with consistent node metrics and deltas", () => {
    const after = applyIntake(s, events, Date.parse("2026-09-27T05:00:00Z"))
    expect(after.snapshot_id).not.toBe(s.snapshot_id)
    expect(after.totals.conversations).toBe(s.totals.conversations + 300)
    expect(after.clusters.reduce((a, c) => a + c.conversations, 0)).toBe(after.totals.conversations)
    for (const cat of after.categories) {
      const kids = after.clusters.filter((c) => c.parent_id === cat.id)
      expect(cat.conversations).toBe(kids.reduce((a, k) => a + k.conversations, 0))
      expect(cat.friction.conversations).toBe(kids.reduce((a, k) => a + k.friction.conversations, 0))
    }
    const d = intakeDeltas(s, after)
    expect(d.length).toBeLessThanOrEqual(8)
    expect(d[0].conversations_after).toBeGreaterThan(d[0].conversations_before)
  })
})
