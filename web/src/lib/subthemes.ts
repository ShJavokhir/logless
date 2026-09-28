// Third map level: sub-theme bubbles packed inside one leaf circle. Pure
// geometry — area ∝ each sub-theme's share of the leaf, so the children fill
// the leaf the same way whatever its current (possibly intake-updated) size.

import { packEnclose, packSiblings } from "d3-hierarchy"
import type { Subtheme, SubthemesResponse } from "./types"

export type SubCircle = { item: Subtheme; x: number; y: number; r: number; share: number }

/** Fraction of the leaf radius the sub-bubbles may fill, and how far they sit
 * below centre to leave the top rim free for the leaf's curved label. */
export const SUB_FILL = 0.8
export const SUB_DROP = 0.07

/** Real sub-themes first (largest first); the untitled remainder packs last. */
export function orderSubthemes(items: Subtheme[]): Subtheme[] {
  return [...items].sort((a, b) => Number(!!a.rest) - Number(!!b.rest) || b.conversations - a.conversations || a.id.localeCompare(b.id))
}

export function packSubthemes(leaf: { x: number; y: number; r: number }, items: Subtheme[], gap = 0): SubCircle[] {
  const list = orderSubthemes(items).filter((s) => s.conversations > 0)
  const total = list.reduce((a, s) => a + s.conversations, 0)
  if (list.length < 2 || total <= 0 || leaf.r <= 0) return []
  const raw = list.map((s) => ({ r: Math.sqrt(s.conversations / total), x: 0, y: 0 }))
  // gap is in leaf-radius units; pad before packing, trim after scaling
  const pad = gap / 2
  const padded = raw.map((c) => ({ ...c, r: c.r + pad }))
  packSiblings(padded)
  const enc = packEnclose(padded) ?? { x: 0, y: 0, r: 1 }
  const scale = (leaf.r * SUB_FILL) / Math.max(1e-9, enc.r)
  const cy = leaf.y + leaf.r * SUB_DROP
  return list.map((item, i) => ({
    item,
    share: item.conversations / total,
    x: leaf.x + (padded[i].x - enc.x) * scale,
    y: cy + (padded[i].y - enc.y) * scale,
    r: Math.max(0, (padded[i].r - pad) * scale),
  }))
}

/** A question result row can be a sub-theme: its display name and the workflow it belongs to. */
export type SubthemeRef = { name: string; leafId: string }

/** Sub-theme id -> name and workflow. Untitled sub-themes are named after their workflow, the same
 * way the backend names them for the model. */
export function subthemeRefs(resp: SubthemesResponse | null, leafName: (leafId: string) => string | undefined): Map<string, SubthemeRef> {
  const out = new Map<string, SubthemeRef>()
  for (const [leafId, items] of Object.entries(resp?.leaves ?? {})) {
    const leaf = leafName(leafId) ?? "this workflow"
    for (const s of items) {
      const name = s.short_title?.trim() || (s.rest ? `Rest of ${leaf}` : `Unnamed part of ${leaf}`)
      out.set(s.id, { name, leafId })
    }
  }
  return out
}
