// Shapes the snapshot into a two-level tree and runs the d3 pack layout.
// The layout depends only on (snapshot, width, height); highlight, selection,
// lens and zoom are rendering concerns and never feed back into it, so nothing
// moves when those change.

import { packEnclose, packSiblings } from "d3-hierarchy"
import type { Node as SnapshotNode, Snapshot } from "./types"

export type TreeDatum =
  | { kind: "root"; id: "root"; children: TreeDatum[] }
  | { kind: "category"; id: string; node: SnapshotNode; children: TreeDatum[] }
  | { kind: "leaf"; id: string; node: SnapshotNode }

export type PackedCircle = {
  id: string
  kind: "category" | "leaf"
  parentId: string | null
  node: SnapshotNode
  x: number
  y: number
  r: number
}

export type PackedLayout = {
  width: number
  height: number
  categories: PackedCircle[]
  leaves: PackedCircle[]
  byId: Map<string, PackedCircle>
}

const byConversationsDesc = (a: SnapshotNode, b: SnapshotNode) =>
  b.conversations - a.conversations || a.id.localeCompare(b.id)

/**
 * Builds the tree from `categories` + `clusters`, using each leaf's `parent_id`
 * as the source of truth (cross-checked against `children`). Leaves whose parent
 * is missing are returned in `orphans` and left out of the map.
 */
export function buildTree(snapshot: Pick<Snapshot, "categories" | "clusters">): {
  root: TreeDatum
  orphans: SnapshotNode[]
} {
  const catIds = new Set(snapshot.categories.map((c) => c.id))
  const byParent = new Map<string, SnapshotNode[]>()
  const orphans: SnapshotNode[] = []
  for (const leaf of snapshot.clusters) {
    if (!leaf.parent_id || !catIds.has(leaf.parent_id)) {
      orphans.push(leaf)
      continue
    }
    const list = byParent.get(leaf.parent_id) ?? []
    list.push(leaf)
    byParent.set(leaf.parent_id, list)
  }
  const cats = [...snapshot.categories].sort(byConversationsDesc)
  const root: TreeDatum = {
    kind: "root",
    id: "root",
    children: cats
      .map((cat): TreeDatum => ({
        kind: "category",
        id: cat.id,
        node: cat,
        children: (byParent.get(cat.id) ?? [])
          .slice()
          .sort(byConversationsDesc)
          .map((leaf): TreeDatum => ({ kind: "leaf", id: leaf.id, node: leaf })),
      }))
      .filter((c) => c.kind === "category" && c.children.length > 0),
  }
  return { root, orphans }
}

export type PackOptions = {
  /** gap between category circles (px) */
  categoryPadding?: number
  /** gap between sibling leaves (px) */
  leafPadding?: number
  /** inset between a category rim and its leaves (px); holds the curved label */
  categoryBand?: number
  /** outer margin (px) */
  margin?: number
}

type Raw = { r: number; x: number; y: number }

/**
 * Two-level circle packing. Leaves are packed per category with `packSiblings`
 * (area ∝ conversations), each category is enclosed with `packEnclose` plus a
 * label band, then categories are packed and the whole is scaled to fit.
 * Pixel paddings are converted to raw units and refined over a few passes so
 * they come out at (almost exactly) the requested pixel size.
 */
export function packLayout(
  snapshot: Pick<Snapshot, "categories" | "clusters">,
  width: number,
  height: number,
  opts: PackOptions = {},
): PackedLayout {
  const { categoryPadding = 14, leafPadding = 3, categoryBand = 16, margin = 8 } = opts
  const { root } = buildTree(snapshot)
  const groups = root.kind === "root" ? root.children.filter((c) => c.kind === "category") : []

  const once = (scale: number) => {
    const lp = leafPadding / scale
    const band = categoryBand / scale
    const cp = categoryPadding / scale
    const cats = groups.map((g) => {
      const kids = g.kind === "category" ? g.children : []
      const circles = kids.map((l) => ({ r: Math.sqrt(Math.max(l.kind === "leaf" ? l.node.conversations : 0, 0.0001)) + lp / 2, x: 0, y: 0 }))
      packSiblings(circles)
      const enc = packEnclose(circles) ?? { x: 0, y: 0, r: 0 }
      const leaves: Raw[] = circles.map((c) => ({ x: c.x - enc.x, y: c.y - enc.y, r: c.r - lp / 2 }))
      return { g, leaves, R: enc.r - lp / 2 + band }
    })
    const catCircles = cats.map((c) => ({ r: c.R + cp / 2, x: 0, y: 0 }))
    packSiblings(catCircles)
    const enc = packEnclose(catCircles) ?? { x: 0, y: 0, r: 1 }
    return { cats, catCircles, enc, rootR: Math.max(1e-6, enc.r - cp / 2) }
  }

  // Fit the packed categories' bounding box (not their enclosing circle) into
  // the viewport, trying a few rotations; rotation keeps the packing valid and
  // lets wide containers use their width.
  const availW = Math.max(1, width - margin * 2)
  const availH = Math.max(1, height - margin * 2)
  const ANGLES = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165]
  const fit = (p: ReturnType<typeof once>) => {
    let best = { k: 0, angle: 0, minX: 0, minY: 0, bw: 1, bh: 1 }
    for (const deg of ANGLES) {
      const a = (deg * Math.PI) / 180
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      p.cats.forEach((c, i) => {
        const cc = p.catCircles[i]
        const x = cc.x * cos - cc.y * sin
        const y = cc.x * sin + cc.y * cos
        minX = Math.min(minX, x - c.R)
        maxX = Math.max(maxX, x + c.R)
        minY = Math.min(minY, y - c.R)
        maxY = Math.max(maxY, y + c.R)
      })
      const bw = Math.max(1e-6, maxX - minX)
      const bh = Math.max(1e-6, maxY - minY)
      const k = Math.min(availW / bw, availH / bh)
      if (k > best.k * 1.0005) best = { k, angle: a, minX, minY, bw, bh }
    }
    return best
  }

  const totalConv = groups.reduce((a, g) => a + (g.kind === "category" ? g.node.conversations : 0), 0)
  let scale = Math.min(availW, availH) / 2 / Math.max(1, Math.sqrt(totalConv) * 1.25)
  let pass = once(scale)
  let best = fit(pass)
  for (let i = 0; i < 5; i++) {
    const next = best.k
    if (Math.abs(next - scale) / scale < 1e-4) break
    scale = next
    pass = once(scale)
    best = fit(pass)
  }
  const k = best.k
  const cos = Math.cos(best.angle)
  const sin = Math.sin(best.angle)
  const offX = margin + (availW - best.bw * k) / 2 - best.minX * k
  const offY = margin + (availH - best.bh * k) / 2 - best.minY * k
  const place = (x: number, y: number) => ({ x: (x * cos - y * sin) * k + offX, y: (x * sin + y * cos) * k + offY })

  const categories: PackedCircle[] = []
  const leaves: PackedCircle[] = []
  const byId = new Map<string, PackedCircle>()
  pass.cats.forEach((c, i) => {
    const cc = pass.catCircles[i]
    if (c.g.kind !== "category") return
    const o = place(cc.x, cc.y)
    const cat: PackedCircle = { id: c.g.id, kind: "category", parentId: null, node: c.g.node, x: o.x, y: o.y, r: c.R * k }
    categories.push(cat)
    byId.set(cat.id, cat)
    c.g.children.forEach((l, j) => {
      if (l.kind !== "leaf") return
      const raw = c.leaves[j]
      const pos = place(cc.x + raw.x, cc.y + raw.y)
      const leaf: PackedCircle = { id: l.id, kind: "leaf", parentId: c.g.id, node: l.node, x: pos.x, y: pos.y, r: raw.r * k }
      leaves.push(leaf)
      byId.set(leaf.id, leaf)
    })
  })
  return { width, height, categories, leaves, byId }
}

/** Transform that fits `circle` into the viewport (for category zoom). */
export function zoomTransform(
  circle: Pick<PackedCircle, "x" | "y" | "r"> | null,
  width: number,
  height: number,
  fill = 0.94,
): { k: number; tx: number; ty: number } {
  if (!circle || circle.r <= 0) return { k: 1, tx: 0, ty: 0 }
  const k = (Math.min(width, height) * fill) / (2 * circle.r)
  return { k, tx: width / 2 - circle.x * k, ty: height / 2 - circle.y * k }
}
