import { describe, expect, it } from "vitest"
import { uniqueModelLabels } from "./snapshot"

describe("model provenance", () => {
  it("includes flash models instead of hiding a provider from the footer", () => {
    const labels = uniqueModelLabels({ extraction: "glm-4.7", judge: "gemini-2.5-flash", duplicate: "gemini-2.5-flash" })
    expect(labels).toContain("gemini-2.5-flash")
    expect(labels.filter((label) => label === "gemini-2.5-flash")).toHaveLength(1)
  })
})
