import { describe, expect, it } from "vitest"
import { arcLabelFits, ellipsizeLabel, estimateMeasure, fitCircleLabel, labelText } from "./labels"

describe("labelText", () => {
  it("prefers short_title and falls back to title", () => {
    expect(labelText({ title: "Debugging Python and JavaScript errors", short_title: "Debugging errors" })).toBe("Debugging errors")
    expect(labelText({ title: "Debugging Python and JavaScript errors" })).toBe("Debugging Python and JavaScript errors")
    expect(labelText({ title: "Full", short_title: "  " })).toBe("Full")
  })
})

describe("fitCircleLabel", () => {
  it("picks the largest font that fits and keeps all words", () => {
    const big = fitCircleLabel("Debugging errors", 60, { measure: estimateMeasure })
    expect(big?.fontSize).toBe(13)
    expect(big?.lines.join(" ")).toBe("Debugging errors")
    const small = fitCircleLabel("Debugging errors", 32, { measure: estimateMeasure })
    expect(small).not.toBeNull()
    expect(small!.fontSize).toBeLessThan(13)
    expect(small!.fontSize).toBeGreaterThanOrEqual(10)
    expect(small!.lines.join(" ")).toBe("Debugging errors")
  })

  it("never goes below the minimum font and returns null when nothing fits", () => {
    expect(fitCircleLabel("Unrestricted personas", 14, { measure: estimateMeasure })).toBeNull()
  })

  it("adds a sub-line only when there is room at the chosen font", () => {
    expect(fitCircleLabel("Chat bots", 70, { subLine: true, measure: estimateMeasure })?.sub).toBe(true)
    const tight = fitCircleLabel("Chat bots", 22, { subLine: true, measure: estimateMeasure })
    expect(tight).not.toBeNull()
  })
})

describe("ellipsizeLabel / arcLabelFits", () => {
  it("ellipsizes long text to fit one line", () => {
    const lab = ellipsizeLabel("Build and fix desktop and mobile applications", 30, 10, estimateMeasure)
    expect(lab?.lines[0].endsWith("…")).toBe(true)
    expect(estimateMeasure(lab!.lines[0], 10)).toBeLessThanOrEqual(2 * Math.sqrt(30 * 30 - 5.8 * 5.8) - 6)
  })
  it("checks curved category labels against the arc length", () => {
    expect(arcLabelFits("Software", 120, 10.5, 0.9, estimateMeasure)).toBe(true)
    expect(arcLabelFits("Manage communication and wellbeing", 40, 10.5, 0.9, estimateMeasure)).toBe(false)
  })
})
