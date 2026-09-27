import { describe, expect, it } from "vitest"
import { fillTemplate, resolvePath, segmentsToString } from "./template"

const result = {
  intent: "usage",
  total_conversations: 5050,
  rows: [
    { cluster_id: "cl_aaaaaa", conversations: 448, users: 371, share: 0.0887 },
    { cluster_id: "cl_bbbbbb", conversations: 412, users: 11, share: 0.0816 },
  ],
}
const titles: Record<string, string> = { cl_aaaaaa: "Debugging errors", cl_bbbbbb: "Image prompts" }
const titleOf = (id: string) => titles[id]

describe("fillTemplate", () => {
  it("fills numbers, shares and cluster titles from the result", () => {
    const segs = fillTemplate(
      "{{rows.0.cluster_id}} has {{rows.0.conversations}} of {{total_conversations}} ({{rows.0.share}}); {{rows[1].cluster_id}} has {{ rows.1.users }} people.",
      result,
      titleOf,
    )
    expect(segmentsToString(segs)).toBe("Debugging errors has 448 of 5,050 (8.9%); Image prompts has 11 people.")
    expect(segs.filter((s) => s.kind === "metric")).toHaveLength(6)
  })

  it("keeps unresolvable placeholders visible as missing, never inventing a value", () => {
    const segs = fillTemplate("Top: {{rows.9.conversations}} and {{nope}}.", result, titleOf)
    const missing = segs.filter((s) => s.kind === "missing")
    expect(missing.map((s) => (s.kind === "missing" ? s.key : ""))).toEqual(["rows.9.conversations", "nope"])
    expect(segmentsToString(segs)).toBe("Top: unavailable and unavailable.")
  })

  it("ignores literal numbers in plain text (only placeholders become metrics)", () => {
    const segs = fillTemplate("No placeholders, 42 is just text.", result)
    expect(segs).toEqual([{ kind: "text", text: "No placeholders, 42 is just text." }])
  })

  it("does not walk prototype properties", () => {
    expect(resolvePath(result, "rows.constructor")).toBeUndefined()
    expect(resolvePath(result, "__proto__")).toBeUndefined()
  })
})
