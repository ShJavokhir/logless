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

describe("stable layout across snapshot updates", () => {
  it("keeps order and rotation when sizes change", async () => {
    const { layoutOrderOf } = await import("./hierarchy")
    const base = packLayout(snapshot, 900, 700)
    const order = layoutOrderOf(snapshot)
    const grown = structuredClone(snapshot)
    // make the smallest leaf the biggest: without a pinned order it would move to the front
    const small = [...grown.clusters].sort((a, b) => a.conversations - b.conversations)[0]
    small.conversations += 600
    const pinned = packLayout(grown, 900, 700, { order, angle: base.angle })
    expect(pinned.angle).toBe(base.angle)
    expect(pinned.categories.map((c) => c.id)).toEqual(base.categories.map((c) => c.id))
    const moved = pinned.categories.map((c) => Math.hypot(c.x - base.byId.get(c.id)!.x, c.y - base.byId.get(c.id)!.y))
    expect(Math.max(...moved)).toBeLessThan(250)
  })
})

describe("lerpLayout", () => {
  it("interpolates circles by id between two layouts", async () => {
    const { lerpLayout } = await import("./hierarchy")
    const a = packLayout(snapshot, 900, 700)
    const grown = structuredClone(snapshot)
    grown.clusters[0].conversations += 200
    const b = packLayout(grown, 900, 700)
    const mid = lerpLayout(a, b, 0.5)
    const id = b.leaves[0].id
    expect(mid.byId.get(id)!.r).toBeCloseTo((a.byId.get(id)!.r + b.byId.get(id)!.r) / 2, 6)
    expect(lerpLayout(a, b, 1).byId.get(id)!.x).toBeCloseTo(b.byId.get(id)!.x, 6)
    expect(lerpLayout(a, b, 0).byId.get(id)!.x).toBeCloseTo(a.byId.get(id)!.x, 6)
  })
})
