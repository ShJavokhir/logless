import { describe, expect, it } from "vitest"
import { categoryEmphasis, createLatestGuard, highlightFromResults, leafEmphasis, NO_HIGHLIGHT } from "./search"

const clusters = [
  { id: "cl_a", parent_id: "cat_1" },
  { id: "cl_b", parent_id: "cat_1" },
  { id: "cl_c", parent_id: "cat_2" },
  { id: "cl_other", parent_id: "cat_3" },
]

describe("highlightFromResults", () => {
  it("marks relevant as match, unclear as partial, and lights parent categories", () => {
    const s = highlightFromResults(
      {
        results: [
          { cluster_id: "cl_a", relevance: "relevant", p: 0.9 },
          { cluster_id: "cl_c", relevance: "unclear", p: 0.5 },
          { cluster_id: "cl_b", relevance: "not_relevant", p: 0.1 },
        ],
      },
      clusters,
    )
    expect(s.active).toBe(true)
    expect(s.empty).toBe(false)
    expect(leafEmphasis(s, "cl_a")).toBe("match")
    expect(leafEmphasis(s, "cl_c")).toBe("partial")
    expect(leafEmphasis(s, "cl_b")).toBe("dim")
    expect(categoryEmphasis(s, "cat_1")).toBe("match")
    expect(categoryEmphasis(s, "cat_2")).toBe("match")
    expect(categoryEmphasis(s, "cat_3")).toBe("dim")
    expect(s.matchCount).toBe(1)
  })

  it("reports an empty result and ignores unknown cluster ids", () => {
    const s = highlightFromResults({ results: [{ cluster_id: "cl_zzz", relevance: "relevant", p: 1 }] }, clusters)
    expect(s.active).toBe(true)
    expect(s.empty).toBe(true)
    expect(leafEmphasis(s, "cl_a")).toBe("dim")
  })

  it("is inert with no response", () => {
    expect(highlightFromResults(null, clusters)).toBe(NO_HIGHLIGHT)
    expect(leafEmphasis(NO_HIGHLIGHT, "cl_a")).toBe("none")
  })
})

describe("createLatestGuard", () => {
  it("only the newest request is current", () => {
    const g = createLatestGuard()
    const first = g.begin()
    const second = g.begin()
    expect(g.isCurrent(first)).toBe(false)
    expect(g.isCurrent(second)).toBe(true)
    g.invalidate()
    expect(g.isCurrent(second)).toBe(false)
  })
})

describe("highlightFromRows", () => {
  it("lights leaf rows and their categories; category rows light all their leaves", async () => {
    const { highlightFromRows } = await import("./search")
    const leafRows = highlightFromRows(["cl_a"], clusters)
    expect(leafEmphasis(leafRows, "cl_a")).toBe("match")
    expect(leafEmphasis(leafRows, "cl_b")).toBe("dim")
    expect(categoryEmphasis(leafRows, "cat_1")).toBe("match")
    const catRows = highlightFromRows(["cat_1"], clusters)
    expect(leafEmphasis(catRows, "cl_a")).toBe("match")
    expect(leafEmphasis(catRows, "cl_b")).toBe("match")
    expect(leafEmphasis(catRows, "cl_c")).toBe("dim")
  })
})
