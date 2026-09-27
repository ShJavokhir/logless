import { describe, expect, it } from "vitest"
import type { Plan } from "./types"
import { planShareNote, planToPhrases, planToWords } from "./plan"

const titles: Record<string, string> = { cat_soft: "Build software" }
const titleOf = (id: string) => titles[id]
const plan = (p: Partial<Plan>): Plan => ({ group_by: "leaf", scope_category_id: null, measure: "conversations", signal: null, rank_by: "count", limit: 5, ...p })

describe("planToWords", () => {
  it("matches the contract example", () => {
    expect(planToWords(plan({ measure: "people", signal: "repeat_request", scope_category_id: "cat_soft" }), titleOf)).toBe(
      "Distinct people · with repeated requests · within Build software · by workflow · top 5 by count",
    )
  })
  it("covers every signal and drops the phrase for no signal", () => {
    expect(planToPhrases(plan({ signal: "any_friction" }), titleOf)[1]).toBe("with any friction")
    expect(planToPhrases(plan({ signal: "correction" }), titleOf)[1]).toBe("with corrections")
    expect(planToPhrases(plan({ signal: "assistant_limit" }), titleOf)[1]).toBe("hitting assistant limits")
    expect(planToPhrases(plan({ signal: "complaint" }), titleOf)[1]).toBe("with complaints")
    expect(planToWords(plan({}), titleOf)).toBe("Conversations · across all workflows · by workflow · top 5 by count")
  })
  it("handles category grouping and share ranking", () => {
    expect(planToWords(plan({ group_by: "category", signal: "complaint", rank_by: "share", limit: 3 }), titleOf)).toBe(
      "Conversations · with complaints · across all categories · by category · top 3 by share",
    )
    expect(planShareNote(plan({ measure: "people", signal: "assistant_limit" }))).toBe(
      "Share = distinct people hitting assistant limits ÷ all distinct people in that workflow.",
    )
  })
})
