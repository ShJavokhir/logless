import { describe, expect, it } from "vitest"
import realJson from "@/mocks/real-snapshot.json"
import mockJson from "@/mocks/snapshot.json"
import type { Node, Snapshot } from "./types"
import { concentrationFinding, FINDING_MIN_LEAF_CONVERSATIONS, frictionFinding, keyFindings } from "./findings"

const real = realJson as unknown as Snapshot
const mock = mockJson as unknown as Snapshot

describe("frictionFinding", () => {
  it("finds the category most over-represented in friction (real snapshot)", () => {
    const f = frictionFinding(real)!
    expect(f).not.toBeNull()
    expect(f.category.is_other).toBeFalsy()
    // denominators are the full totals (Other included)
    expect(f.conversationShare).toBeCloseTo(f.category.conversations / real.totals.conversations, 10)
    expect(f.frictionShare).toBeCloseTo(f.category.friction.conversations / real.totals.friction.conversations, 10)
    // the winner beats every other non-Other category on the pp difference
    for (const c of real.categories.filter((c) => !c.is_other)) {
      const d = c.friction.conversations / real.totals.friction.conversations - c.conversations / real.totals.conversations
      expect(d).toBeLessThanOrEqual(f.overRepresentation + 1e-12)
    }
  })

  it("picks the highest-rate leaf with enough conversations", () => {
    const f = frictionFinding(real)!
    expect(f.leafMeetsMinimum).toBe(true)
    expect(f.leaf!.parent_id).toBe(f.category.id)
    expect(f.leaf!.conversations).toBeGreaterThanOrEqual(FINDING_MIN_LEAF_CONVERSATIONS)
    const rivals = real.clusters.filter((l) => l.parent_id === f.category.id && !l.is_other && l.conversations >= FINDING_MIN_LEAF_CONVERSATIONS)
    for (const l of rivals) expect(l.friction.share ?? 0).toBeLessThanOrEqual(f.leaf!.friction.share ?? 0)
  })

  it("never picks Other, and returns null without friction or over-representation", () => {
    const cat = (id: string, conv: number, fric: number, other = false) =>
      ({ id, conversations: conv, friction: { conversations: fric }, is_other: other }) as unknown as Node
    const base = { totals: { conversations: 100, friction: { conversations: 20 } } } as unknown as Snapshot
    // Other is the most over-represented but must be skipped
    const s1 = { ...base, categories: [cat("cat_other", 10, 10, true), cat("cat_a", 30, 8), cat("cat_b", 60, 2)], clusters: [] }
    expect(frictionFinding(s1)?.category.id).toBe("cat_a")
    // proportional friction → nothing over-represented
    const s2 = { ...base, categories: [cat("cat_a", 50, 10), cat("cat_b", 50, 10)], clusters: [] }
    expect(frictionFinding(s2)).toBeNull()
    const s3 = { totals: { conversations: 100, friction: { conversations: 0 } }, categories: [cat("cat_a", 100, 0)], clusters: [] } as unknown as Snapshot
    expect(frictionFinding(s3)).toBeNull()
  })

  it("falls back to any leaf when none reaches the minimum", () => {
    const leaf = (id: string, conv: number, share: number) =>
      ({ id, parent_id: "cat_a", conversations: conv, users: conv, friction: { share, conversations: Math.round(conv * share) } }) as unknown as Node
    const s = {
      totals: { conversations: 100, friction: { conversations: 10 } },
      categories: [{ id: "cat_a", conversations: 40, friction: { conversations: 8 } }, { id: "cat_b", conversations: 60, friction: { conversations: 2 } }],
      clusters: [leaf("cl_1", 30, 0.1), leaf("cl_2", 10, 0.5)],
    } as unknown as Snapshot
    const f = frictionFinding(s)!
    expect(f.leafMeetsMinimum).toBe(false)
    expect(f.leaf!.id).toBe("cl_2")
  })
})

describe("concentrationFinding", () => {
  it("reports the most people-concentrated workflow when it is striking", () => {
    const c = concentrationFinding(mock)!
    expect(c.leaf.title).toMatch(/Midjourney/)
    expect(c.ratio).toBeCloseTo(412 / 11, 5)
    const r = concentrationFinding(real)
    if (r) {
      expect(r.ratio).toBeGreaterThanOrEqual(3)
      expect(r.leaf.is_other).toBeFalsy()
    }
  })
  it("returns nothing below the threshold", () => {
    expect(concentrationFinding({ clusters: [{ id: "cl_a", conversations: 20, users: 10 } as unknown as Node] })).toBeNull()
  })
  it("keyFindings bundles both", () => {
    const k = keyFindings(mock)
    expect(k.friction).not.toBeNull()
    expect(k.concentration).not.toBeNull()
  })
})
