import { describe, expect, it } from "vitest"
import { glmEtaLabel, glmPaceLabel, glmRate, glmSeconds, resultLine } from "./ultrasort"

describe("ultrasort GLM estimate", () => {
  it("is capped by the rate limit, not the parallel calls", () => {
    expect(glmRate()).toBe(2)
    expect(glmSeconds(5000)).toBe(2500)
  })

  it("labels every GLM figure as an estimate", () => {
    expect(glmPaceLabel()).toBe("GLM est. 2.0 conversations/s (120 calls/min limit)")
    expect(glmEtaLabel(5000)).toBe("GLM est. 41 min 40 s for 5,000")
  })

  it("puts Jev's measured time next to GLM's estimate", () => {
    expect(resultLine(5000, 41.66)).toBe("Jev sorted 5,000 in 41.7 s, measured · GLM est. 41 min 40 s (~60× longer, est.)")
    expect(resultLine(5000, 0)).toBe("Jev sorted 5,000 in 0 ms, measured · GLM est. 41 min 40 s")
  })
})
