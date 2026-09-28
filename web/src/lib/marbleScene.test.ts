// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMarbleScene, type MarbleScene } from "./marbleScene"

// Keep real scene geometry and bookkeeping; replace only the GPU boundary.
vi.mock("three", async (importOriginal) => {
  const three = await importOriginal<typeof import("three")>()
  return {
    ...three,
    WebGLRenderer: class {
      shadowMap = {}
      setPixelRatio() {}
      setSize() {}
      render() {}
      dispose() {}
    },
    PMREMGenerator: class {
      fromScene() { return { texture: new three.Texture() } }
      dispose() {}
    },
  }
})

let frame: FrameRequestCallback
let time: number
let scene: MarbleScene | undefined

beforeEach(() => {
  time = 0
  vi.spyOn(performance, "now").mockImplementation(() => time)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal("cancelAnimationFrame", () => {})
  const ctx = new Proxy({ measureText: () => ({ width: 20 }) }, {
    get: (target, key) => target[key as keyof typeof target] ?? (() => {}),
  })
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  scene?.dispose()
  scene = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function makeScene(reducedMotion = false) {
  scene = createMarbleScene(document.createElement("canvas"), {
    capacity: 3,
    bins: [{ label: "Workflow", hue: 250, weight: 1 }],
    armed: true,
    dripCapacity: 2,
    dripHold: 1.5,
    reducedMotion,
  })
  scene.resize(800, 600)
  return scene
}

function advance(ms: number) {
  time += ms
  frame(time)
}

describe("marble scene replay and Ultrasort integration", () => {
  it("keeps simulated baseline drips out of published counts", () => {
    const s = makeScene()
    expect(s.drip(0)).toBe(true)
    advance(10_000)
    expect(s.stats()).toMatchObject({ spawned: 0, landed: 0, drips: 1 })
    s.ultrasort()
    advance(1000)
    expect(s.stats()).toMatchObject({ spawned: 0, landed: 0, drips: 0 })
  })

  it.each([false, true])("counts replay drips once across Ultrasort (reduced motion: %s)", (reducedMotion) => {
    const s = makeScene(reducedMotion)
    expect(s.drip(0, { friction: true })).toBe(true)
    advance(reducedMotion ? 1 : 10_000)
    expect(s.stats()).toMatchObject({ spawned: 1, landed: 1, bins: [{ landed: 1, friction: 1 }] })
    s.ultrasort()
    expect(s.drip(0, { friction: false })).toBe(false)
    s.push(0, false)
    s.push(0, true)
    for (let i = 0; i < 5; i++) advance(1000)
    expect(s.stats()).toMatchObject({ spawned: 3, landed: 3, drained: true, bins: [{ landed: 3, friction: 2 }] })
  })

  it("does not recycle counted drips when the pool is full", () => {
    const s = makeScene(true)
    expect(s.drip(0, { friction: true })).toBe(true)
    expect(s.drip(0, { friction: false })).toBe(true)
    expect(s.drip(0, { friction: false })).toBe(false)
    expect(s.drip(0)).toBe(false)
    expect(s.stats()).toMatchObject({ spawned: 2, landed: 2, bins: [{ landed: 2, friction: 1 }] })
  })
})
