import type { SnapshotIndex } from "@/lib/snapshot"
import type { Node as SnapshotNode, Signal } from "@/lib/types"
import { SIGNALS } from "@/lib/types"

// Same ranking as the PRD endpoint (backend/logless/api/prds.py `priority`): published
// workflows outside Other, ordered by conversations with a friction signal.
export const P0_TOP = 5
export const P1_TOP = 15

export type Item = { leaf: SnapshotNode; rank: number; level: "P0" | "P1" | "P2"; top: Signal | null }

export function roadmap(index: SnapshotIndex): Item[] {
  const otherCats = new Set(index.categories.filter((c) => c.is_other).map((c) => c.id))
  const pool = index.snapshot.clusters
    .filter((c) => c.level === 2 && c.id !== "cl_other" && !c.is_other && !(c.parent_id && otherCats.has(c.parent_id)))
    .sort((a, b) => b.friction.conversations - a.friction.conversations || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return pool.map((leaf, i) => {
    const rank = i + 1
    const sig = leaf.friction.signals
    const top = SIGNALS.reduce<Signal | null>((best, s) => (sig[s] > (best ? sig[best] : 0) ? s : best), null)
    return { leaf, rank, level: rank <= P0_TOP ? "P0" : rank <= P1_TOP ? "P1" : "P2", top }
  })
}

