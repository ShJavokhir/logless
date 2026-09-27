import { describe, expect, it } from "vitest"
import { createIntakeFlights, FLOW_FLIGHT_MS, flowRows, flowStep } from "./intakeFlow"
import { createIntakeScheduler } from "./intake"
import { indexSnapshot } from "./snapshot"
import { generateIntakeEvents, applyIntake } from "@/mocks/intake"
import realJson from "@/mocks/real-snapshot.json"
import type { IntakeEvent, Snapshot } from "./types"

const snapshot = realJson as unknown as Snapshot
const events = generateIntakeEvents(snapshot, 7)

function harness(reducedMotion = false) {
  const scheduler = createIntakeScheduler<IntakeEvent>({ leadMs: 0, reducedMotion })
  const spawned: number[] = []
  const landed: IntakeEvent[] = []
  const visual = { scheduler, reducedMotion, heartbeat() {}, onSpawn: (e: IntakeEvent) => { spawned.push(e.seq) }, onLand: (e: IntakeEvent) => { landed.push(e) } }
  return { scheduler, visual, spawned, landed, flights: createIntakeFlights(visual) }
}

describe("intake flow lifecycle", () => {
  it("does not let publication drain before all 300 real decisions land", () => {
    const h = harness()
    h.scheduler.push(events, 0)
    h.flights.tick(0)
    expect(h.scheduler.drained).toBe(false)
    expect(h.landed).toHaveLength(0)
    for (let t = 16; t < 15000; t += 16) h.flights.tick(t)
    expect(h.scheduler.drained).toBe(true)
    expect(h.landed).toHaveLength(300)
    expect(new Set(h.spawned).size).toBe(300)
    expect(new Set(h.landed.map((e) => e.seq)).size).toBe(300)
    const rows = flowRows(indexSnapshot(snapshot), h.landed)
    expect(rows.reduce((n, row) => n + row.events.length, 0)).toBe(300)
    const published = applyIntake(snapshot, events)
    for (const row of rows) {
      expect(row.events.length).toBe(published.categories.find((c) => c.id === row.node.id)!.conversations - row.node.conversations)
    }
  })

  it("flushes active slots exactly once on resize or unmount; pending events remain available", () => {
    const h = harness()
    h.scheduler.push(events, 0)
    h.flights.tick(100)
    expect(h.scheduler.active).toBeGreaterThan(0)
    const active = h.scheduler.active
    h.flights.flush()
    h.flights.flush()
    expect(h.landed).toHaveLength(active)
    expect(h.scheduler.active).toBe(0)
    expect(h.scheduler.pending).toBeGreaterThan(0)
    const resumed = createIntakeFlights(h.visual)
    for (let t = 200; t < 15000; t += 100) resumed.tick(t)
    expect(h.scheduler.drained).toBe(true)
    expect(h.landed).toHaveLength(300)
  })

  it("files every event without flights for reduced motion", () => {
    const h = harness(true)
    h.scheduler.push(events, 0)
    expect(h.flights.tick(15000)).toEqual([])
    expect(h.scheduler.drained).toBe(true)
    expect(h.landed).toHaveLength(300)
  })

  it("catches up after a background pause and ignores repeated event pages", () => {
    const h = harness()
    h.scheduler.push(events.slice(0, 200), 0)
    h.scheduler.push(events, 0)
    h.flights.tick(0)
    h.flights.tick(60000)
    h.flights.tick(60000 + FLOW_FLIGHT_MS)
    expect(h.scheduler.drained).toBe(true)
    expect(h.landed).toHaveLength(300)
  })

  it("trusts the assigned workflow, includes Other, and does not double-count", () => {
    const index = indexSnapshot(snapshot)
    const rows = flowRows(index, [...events, ...events])
    expect(rows.at(-1)?.node.is_other).toBe(true)
    expect(rows.at(-1)?.events.length).toBe(events.filter((e) => e.leaf_id === "cl_other").length)
    expect(rows.reduce((n, r) => n + r.events.length, 0)).toBe(300)
    const unknown = { ...events[0], leaf_id: "unknown" }
    expect(flowRows(index, [unknown]).at(-1)?.events).toEqual([unknown])
  })

  it("shows pre-read as complete and waits for publication to finish the stepper", () => {
    expect(flowStep(null, false)).toBe(1)
    expect(flowStep("filing", false)).toBe(1)
    expect(flowStep("gating", false)).toBe(2)
    expect(flowStep("done", false)).toBe(3)
    expect(flowStep("evaluating", true)).toBe(4)
  })
})
