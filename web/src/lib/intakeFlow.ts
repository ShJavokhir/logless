import type { IntakeVisual } from "@/hooks/useIntake"
import type { SnapshotIndex } from "./snapshot"
import type { IntakeEvent, IntakeStage } from "./types"

export const FLOW_FLIGHT_MS = 1100
export const FLOW_HOLD_MS = 1200

/** Owns every scheduler slot until landing, including teardown and resize. */
export function createIntakeFlights(visual: IntakeVisual) {
  const flights = new Map<number, { event: IntakeEvent; start: number }>()
  const land = (seq: number) => {
    const flight = flights.get(seq)
    if (!flight) return
    flights.delete(seq)
    visual.scheduler.land()
    visual.onLand(flight.event)
  }
  return {
    tick(now: number) {
      visual.heartbeat()
      for (const [seq, flight] of flights) if (now - flight.start >= FLOW_FLIGHT_MS) land(seq)
      const tick = visual.scheduler.tick(now)
      for (const event of tick.instant) {
        visual.onSpawn(event)
        visual.onLand(event)
      }
      for (const event of tick.spawn) {
        visual.onSpawn(event)
        flights.set(event.seq, { event, start: now })
      }
      return [...flights.values()]
    },
    flush() {
      for (const seq of flights.keys()) land(seq)
    },
  }
}

/** Use the server's assigned leaf, never classify again from its probability. */
export function flowRows(index: SnapshotIndex, events: IntakeEvent[]) {
  const rows = [...index.categories]
    .sort((a, b) => Number(!!a.is_other) - Number(!!b.is_other))
    .map((node) => ({ node, events: [] as IntakeEvent[] }))
  const byId = new Map(rows.map((row) => [row.node.id, row]))
  const other = rows.find((row) => row.node.is_other)
  const seen = new Set<number>()
  for (const event of events) {
    if (seen.has(event.seq)) continue
    seen.add(event.seq)
    const parent = index.parentOf(event.leaf_id)
    const row = (parent && byId.get(parent.id)) || other
    row?.events.push(event)
  }
  return rows
}

export function flowStep(stage: IntakeStage | null, published: boolean) {
  if (published) return 4
  if (stage === "publishing" || stage === "evaluating" || stage === "done") return 3
  if (stage === "gating") return 2
  return 1
}
