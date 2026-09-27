// Key findings computed from the published snapshot (never hardcoded).
import type { Node as SnapshotNode, Snapshot } from "./types"

export const FINDING_MIN_LEAF_CONVERSATIONS = 50
export const CONCENTRATION_MIN_RATIO = 3

export type FrictionFinding = {
  category: SnapshotNode
  /** category conversations ÷ all conversations */
  conversationShare: number
  /** category friction conversations ÷ all friction conversations */
  frictionShare: number
  /** frictionShare − conversationShare (percentage points as a 0..1 fraction) */
  overRepresentation: number
  /** where to look first: highest friction rate among the category's leaves */
  leaf: SnapshotNode | null
  /** true when the leaf was picked among leaves with ≥ FINDING_MIN_LEAF_CONVERSATIONS */
  leafMeetsMinimum: boolean
}

export type ConcentrationFinding = { leaf: SnapshotNode; ratio: number }

export type KeyFindings = { friction: FrictionFinding | null; concentration: ConcentrationFinding | null }

const isOther = (n: SnapshotNode) => !!n.is_other || n.id === "cl_other"

/**
 * The category most over-represented in observed friction: its share of all
 * friction conversations minus its share of all conversations (denominators are
 * the snapshot totals, Other included; Other is never a candidate). Ranked by the
 * percentage-point difference, because a ratio explodes for tiny categories.
 * Returns null when there is no friction or nothing is over-represented.
 */
export function frictionFinding(s: Pick<Snapshot, "totals" | "categories" | "clusters">): FrictionFinding | null {
  const totalConv = s.totals.conversations
  const totalFric = s.totals.friction.conversations
  if (!totalConv || !totalFric) return null
  let best: FrictionFinding | null = null
  for (const cat of s.categories) {
    if (isOther(cat) || cat.conversations <= 0) continue
    const conversationShare = cat.conversations / totalConv
    const frictionShare = cat.friction.conversations / totalFric
    const over = frictionShare - conversationShare
    if (over <= 0) continue
    if (!best || over > best.overRepresentation || (over === best.overRepresentation && cat.id < best.category.id)) {
      best = { category: cat, conversationShare, frictionShare, overRepresentation: over, leaf: null, leafMeetsMinimum: false }
    }
  }
  if (!best) return null
  const leaves = s.clusters.filter((l) => l.parent_id === best!.category.id && !isOther(l) && l.friction.share !== null)
  const byRate = (a: SnapshotNode, b: SnapshotNode) =>
    (b.friction.share ?? 0) - (a.friction.share ?? 0) || b.conversations - a.conversations || a.id.localeCompare(b.id)
  const eligible = leaves.filter((l) => l.conversations >= FINDING_MIN_LEAF_CONVERSATIONS).sort(byRate)
  if (eligible.length) return { ...best, leaf: eligible[0], leafMeetsMinimum: true }
  const any = [...leaves].sort(byRate)
  return { ...best, leaf: any[0] ?? null, leafMeetsMinimum: false }
}

/** The workflow with the most conversations per person, if ≥ CONCENTRATION_MIN_RATIO. */
export function concentrationFinding(s: Pick<Snapshot, "clusters">): ConcentrationFinding | null {
  let best: ConcentrationFinding | null = null
  for (const l of s.clusters) {
    if (isOther(l) || l.users <= 0) continue
    const ratio = l.conversations / l.users
    if (ratio < CONCENTRATION_MIN_RATIO) continue
    if (!best || ratio > best.ratio || (ratio === best.ratio && l.conversations > best.leaf.conversations)) best = { leaf: l, ratio }
  }
  return best
}

export function keyFindings(s: Pick<Snapshot, "totals" | "categories" | "clusters">): KeyFindings {
  return { friction: frictionFinding(s), concentration: concentrationFinding(s) }
}
