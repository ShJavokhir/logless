import { describe, expect, it } from "vitest"
import { packSubthemes, SUB_DROP, SUB_FILL, subthemeRefs } from "./subthemes"
import type { Subtheme } from "./types"

const item = (id: string, conversations: number, rest = false): Subtheme => ({ id, short_title: rest ? null : id, conversations, users: 5, rest })

describe("packSubthemes", () => {
  const leaf = { x: 100, y: 200, r: 50 }
  const items = [item("rest", 10, true), item("a", 60), item("b", 30), item("c", 20)]

  it("keeps every child inside the leaf, below the label rim", () => {
    const out = packSubthemes(leaf, items, 0.03)
    expect(out).toHaveLength(4)
    const cy = leaf.y + leaf.r * SUB_DROP
    for (const c of out) {
      expect(Math.hypot(c.x - leaf.x, c.y - cy) + c.r).toBeLessThanOrEqual(leaf.r * SUB_FILL + 1e-6)
      expect(Math.hypot(c.x - leaf.x, c.y - leaf.y) + c.r).toBeLessThanOrEqual(leaf.r)
    }
  })

  it("sizes by share of the leaf and orders the remainder last", () => {
    const out = packSubthemes(leaf, items)
    expect(out.map((c) => c.item.id)).toEqual(["a", "b", "c", "rest"])
    expect(out[0].share).toBeCloseTo(60 / 120)
    expect((out[0].r / out[1].r) ** 2).toBeCloseTo(2, 5)
  })

  it("does not overlap siblings", () => {
    const out = packSubthemes(leaf, items, 0.03)
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        expect(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y)).toBeGreaterThanOrEqual(out[i].r + out[j].r - 1e-6)
  })

  it("draws nothing for fewer than two sub-themes", () => {
    expect(packSubthemes(leaf, [item("a", 40)])).toEqual([])
    expect(packSubthemes(leaf, [])).toEqual([])
  })
})

describe("subthemeRefs", () => {
  it("names sub-themes, falling back to their workflow when untitled", () => {
    const refs = subthemeRefs(
      {
        snapshot_id: "s",
        base_snapshot_id: "s",
        leaves: { cl_aaaaaa: [item("cl_aaaaaa_s1", 20), { ...item("cl_aaaaaa_s2", 10), short_title: null }, item("cl_aaaaaa_rest", 5, true)] },
      },
      (id) => (id === "cl_aaaaaa" ? "Cover letters" : undefined),
    )
    expect(refs.get("cl_aaaaaa_s1")).toEqual({ name: "cl_aaaaaa_s1", leafId: "cl_aaaaaa" })
    expect(refs.get("cl_aaaaaa_s2")?.name).toBe("Unnamed part of Cover letters")
    expect(refs.get("cl_aaaaaa_rest")?.name).toBe("Rest of Cover letters")
    expect(subthemeRefs(null, () => undefined).size).toBe(0)
  })
})
