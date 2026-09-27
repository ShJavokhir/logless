import { describe, expect, it } from "vitest"
import snapshotJson from "@/mocks/snapshot.json"
import type { Snapshot } from "./types"
import { buildTree, packLayout, zoomTransform } from "./hierarchy"

const snapshot = snapshotJson as unknown as Snapshot

describe("buildTree", () => {
  it("nests every leaf under its parent category", () => {
    const { root, orphans } = buildTree(snapshot)
    expect(orphans).toHaveLength(0)
    if (root.kind !== "root") throw new Error("expected root")
    const leafCount = root.children.reduce((a, c) => a + (c.kind === "category" ? c.children.length : 0), 0)
    expect(leafCount).toBe(snapshot.clusters.length)
  })

  it("reports leaves whose parent is missing instead of mis-placing them", () => {
    const broken = { categories: snapshot.categories.slice(1), clusters: snapshot.clusters }
    const { orphans } = buildTree(broken)
    const expected = snapshot.clusters.filter((c) => c.parent_id === snapshot.categories[0].id).length
    expect(orphans).toHaveLength(expected)
  })
})

describe("packLayout", () => {
  const layout = packLayout(snapshot, 900, 700)

  it("sizes leaves by conversations (area ∝ count)", () => {
    const [a, b] = [...layout.leaves].sort((x, y) => y.node.conversations - x.node.conversations)
    const areaRatio = (a.r * a.r) / (b.r * b.r)
    expect(areaRatio).toBeCloseTo(a.node.conversations / b.node.conversations, 5)
  })

  it("keeps every leaf inside its category circle and inside the viewport", () => {
    for (const leaf of layout.leaves) {
      const cat = layout.byId.get(leaf.parentId ?? "")
      expect(cat).toBeDefined()
      const d = Math.hypot(leaf.x - cat!.x, leaf.y - cat!.y)
      expect(d + leaf.r).toBeLessThanOrEqual(cat!.r + 1e-6)
      expect(leaf.x - leaf.r).toBeGreaterThanOrEqual(0)
      expect(leaf.y + leaf.r).toBeLessThanOrEqual(700)
    }
  })

  it("is deterministic for the same input", () => {
    const again = packLayout(snapshot, 900, 700)
    expect(again.leaves.map((l) => [l.id, l.x.toFixed(3), l.y.toFixed(3)])).toEqual(
      layout.leaves.map((l) => [l.id, l.x.toFixed(3), l.y.toFixed(3)]),
    )
  })

  it("computes a zoom transform that centres the circle", () => {
    const cat = layout.categories[0]
    const { k, tx, ty } = zoomTransform(cat, 900, 700)
    expect(cat.x * k + tx).toBeCloseTo(450)
    expect(cat.y * k + ty).toBeCloseTo(350)
    expect(zoomTransform(null, 900, 700)).toEqual({ k: 1, tx: 0, ty: 0 })
  })
})
