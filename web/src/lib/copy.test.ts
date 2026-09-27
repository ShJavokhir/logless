import { describe, expect, it } from "vitest"
import { conversationsPhrase, provenanceHint } from "./copy"

const f = { canary_conversations: 40, injection_conversations: 10 }

describe("provenance copy", () => {
  it("splits the total into WildChat conversations and test fixtures", () => {
    expect(conversationsPhrase(5050, f)).toBe("5,050 conversations (5,000 WildChat + 50 test fixtures)")
    expect(conversationsPhrase(800, undefined)).toBe("800 conversations")
  })
  it("states who computes what, exactly as agreed", () => {
    expect(provenanceHint(5050, f)).toBe(
      "The map is computed by the logless pipeline on Vultr from 5,000 real conversations (+50 test fixtures). Answers to questions are computed by agent-written code in a gVisor sandbox and checked by a gate. No one can open a conversation here.",
    )
  })
})
