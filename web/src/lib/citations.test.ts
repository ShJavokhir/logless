import { describe, expect, it } from "vitest"
import { splitCitations } from "./citations"

describe("splitCitations", () => {
  it("turns inline [n1]/[p2] markers into citation parts", () => {
    expect(splitCitations("She asked for a prompt [n1], but it declined [p1].")).toEqual([
      { kind: "text", text: "She asked for a prompt" },
      { kind: "cite", id: "n1" },
      { kind: "text", text: ", but it declined" },
      { kind: "cite", id: "p1" },
      { kind: "text", text: "." },
    ])
  })
  it("leaves text without markers (and non-evidence brackets) alone", () => {
    expect(splitCitations("No markers [x1] here.")).toEqual([{ kind: "text", text: "No markers [x1] here." }])
  })
})
