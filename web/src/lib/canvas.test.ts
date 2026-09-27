import { describe, expect, it } from "vitest"
import { canvasSpec, validateCanvas } from "./canvas"

const request = { snapshot_id: "snapshot", run_id: "run" }
const response = () => ({ ...request, status: "composed", selected: ["cards", "signals"], spec: canvasSpec(["cards", "signals"]) })

describe("canvas capability boundary", () => {
  it("accepts a bounded composition of registered components", () => {
    expect(validateCanvas(response(), request).selected).toEqual(["cards", "signals"])
  })
  it.each(["other run", "extra data", "event", "cycle", "unknown component", "extra node"])("rejects %s before rendering", (kind) => {
    const value = response()
    if (kind === "other run") value.run_id = "wrong"
    if (kind === "extra data") value.spec.elements.cards.props = { count: 12345 }
    if (kind === "event") value.spec.elements.cards.on = { press: { action: "fetch", params: { url: "https://example.com" } } }
    if (kind === "cycle") value.spec.elements.cards.children = ["canvas"]
    if (kind === "unknown component") value.spec.elements.cards.type = "Script"
    if (kind === "extra node") value.spec.elements.extra = { type: "Ranking", props: {} }
    expect(() => validateCanvas(value, request)).toThrow()
  })
})
