import { describe, expect, it } from "vitest"
import type { Snapshot } from "@/lib/types"
import realJson from "./real-snapshot.json"
import { consistencyChecks, interpretQuestion, questionResult } from "./results"

const s = realJson as unknown as Snapshot

describe("mock question interpreter + result (§8b shape)", () => {
  it("maps the example questions to closed-vocabulary plans", () => {
    const a = interpretQuestion("Which coding workflows have the most distinct people repeating requests?", s)
    expect("plan" in a && a.plan).toMatchObject({ group_by: "leaf", measure: "people", signal: "repeat_request", rank_by: "count", limit: 5 })
    expect("plan" in a && a.plan.scope_category_id).toMatch(/^cat_/)
    const b = interpretQuestion("Where do people hit assistant limits most often, as a share?", s)
    expect("plan" in b && b.plan).toMatchObject({ signal: "assistant_limit", rank_by: "share" })
    const c = interpretQuestion("Which categories have the most complaints?", s)
    expect("plan" in c && c.plan).toMatchObject({ group_by: "category", signal: "complaint", scope_category_id: null })
  })

  it("says unsupported with a short reason", () => {
    const u = interpretQuestion("How will usage change next month?", s)
    expect("unsupported" in u && u.unsupported.length).toBeLessThanOrEqual(160)
  })

  it("orders rows, respects limit and never includes Other", () => {
    const r = questionResult(s, { group_by: "leaf", scope_category_id: null, measure: "conversations", signal: "complaint", rank_by: "share", limit: 7 })
    expect(r.rows).toHaveLength(7)
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i - 1].share >= r.rows[i].share).toBe(true)
    expect(r.rows.some((x) => x.id === "cl_other")).toBe(false)
    for (const row of r.rows) {
      expect(row.count).toBeLessThanOrEqual(row.base)
      expect(row.share).toBeCloseTo(row.count / row.base, 4)
    }
    expect(r.total_count).toBeLessThanOrEqual(r.total_base)
  })

  it("maps 'What's not working?' to a friction plan", () => {
    const p = interpretQuestion("What's not working?", s)
    expect("plan" in p && p.plan).toMatchObject({ group_by: "leaf", measure: "conversations", signal: "any_friction" })
  })

  it("cross-checks results against the published map only where derivable (§0)", () => {
    const friction = questionResult(s, { group_by: "leaf", scope_category_id: null, measure: "conversations", signal: "any_friction", rank_by: "count", limit: 5 })
    const c1 = consistencyChecks(s, friction)
    expect(c1.map((c) => c.name)).toEqual([
      "Consistent with the published map · bases = published workflow conversations",
      "Consistent with the published map · counts = published friction conversations",
    ])
    expect(c1.every((c) => c.passed)).toBe(true)
    const plain = questionResult(s, { group_by: "category", scope_category_id: null, measure: "conversations", signal: null, rank_by: "count", limit: 3 })
    expect(consistencyChecks(s, plain).every((c) => c.passed)).toBe(true)
    const tampered = { ...plain, total_base: plain.total_base + 1 }
    expect(consistencyChecks(s, tampered).some((c) => !c.passed)).toBe(true)
    const peopleSignal = questionResult(s, { group_by: "leaf", scope_category_id: null, measure: "people", signal: "complaint", rank_by: "count", limit: 5 })
    expect(consistencyChecks(s, peopleSignal)).toEqual([])
  })
})
