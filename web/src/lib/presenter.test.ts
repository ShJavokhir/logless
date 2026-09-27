import { describe, expect, it } from "vitest"
import { presenterHeaders } from "./presenter"

describe("presenterHeaders", () => {
  it("sends nothing when no key is stored (node has no window)", () => {
    expect(presenterHeaders()).toEqual({})
  })
})
