import { describe, expect, it } from "vitest"
import { categoryDetail, clampCamera, MAX_ZOOM, OVERVIEW, pinchCamera, zoomAt } from "./mapCamera"
import { packLayout } from "./hierarchy"
import snapshot from "@/mocks/real-snapshot.json"
import type { Snapshot } from "./types"

describe("map camera", () => {
  it("holds the world point under the cursor throughout a zoom", () => {
    const start = { k: 2, tx: -180, ty: -240 }
    const cursor = { x: 370, y: 290 }
    const end = zoomAt(start, cursor, 3.8, 900, 650)
    for (const t of [0, 0.2, 0.5, 0.9, 1]) {
      const k = start.k + (end.k - start.k) * t
      const tx = start.tx + (end.tx - start.tx) * t
      const ty = start.ty + (end.ty - start.ty) * t
      expect((cursor.x - tx) / k).toBeCloseTo((cursor.x - start.tx) / start.k)
      expect((cursor.y - ty) / k).toBeCloseTo((cursor.y - start.ty) / start.k)
    }
  })

  it("bounds panning and repeated extreme wheel input without losing the map", () => {
    let camera = OVERVIEW
    for (let n = 0; n < 100; n++) camera = zoomAt(camera, { x: 400, y: 250 }, camera.k * 1.8, 800, 500)
    expect(camera.k).toBe(MAX_ZOOM)
    expect(clampCamera({ ...camera, tx: 10000, ty: -10000 }, 800, 500)).toEqual({ k: MAX_ZOOM, tx: 0, ty: 500 * (1 - MAX_ZOOM) })
    for (let n = 0; n < 100; n++) camera = zoomAt(camera, { x: 40, y: 480 }, camera.k / 1.8, 800, 500)
    expect(camera).toEqual(OVERVIEW)
  })

  it("keeps a pinched world point under the moving two-finger midpoint", () => {
    const start = { k: 2, tx: -150, ty: -100 }
    const from = { x: 180, y: 140 }
    const to = { x: 230, y: 170 }
    const next = pinchCamera(start, from, to, 1.6, 390, 320)
    expect(next.k).toBeCloseTo(3.2)
    expect((to.x - next.tx) / next.k).toBeCloseTo((from.x - start.tx) / start.k)
    expect((to.y - next.ty) / next.k).toBeCloseTo((from.y - start.ty) / start.k)
    const pan = pinchCamera(start, from, to, 1, 390, 320)
    expect(pan).toEqual({ k: 2, tx: -100, ty: -70 })
  })

  it("clamps pinch scale before translating, even beyond the zoom limit", () => {
    const result = pinchCamera({ k: 7, tx: -900, ty: -800 }, { x: 100, y: 100 }, { x: 120, y: 120 }, 4, 800, 500)
    expect(result.k).toBe(MAX_ZOOM)
    expect((120 - result.tx) / result.k).toBeCloseTo(1000 / 7)
    expect((120 - result.ty) / result.k).toBeCloseTo(900 / 7)
  })
})

describe("semantic detail", () => {
  it.each([[900, 620], [358, 306]])("reveals every real category smoothly at %s × %s", (width, height) => {
    const layout = packLayout(snapshot as unknown as Snapshot, width, height)
    for (const cat of layout.categories) {
      const detail = (k: number) => categoryDetail(k, cat.r, Math.min(width, height))
      expect(detail(1)).toBe(0)
      expect(detail(MAX_ZOOM)).toBe(1)
      let previous = 0
      for (let k = 1; k <= MAX_ZOOM; k += 0.01) {
        const current = detail(k)
        expect(current).toBeGreaterThanOrEqual(previous)
        expect(current - previous).toBeLessThan(0.03)
        previous = current
      }
      const focusZoom = Math.max(1.8, Math.min(MAX_ZOOM, Math.min(width, height) * 0.88 / (2 * cat.r)))
      expect(detail(focusZoom)).toBe(1)
    }
  })

  it("reveals large categories before small ones without moving their bubbles", () => {
    expect(categoryDetail(1.9, 150, 600)).toBeGreaterThan(categoryDetail(1.9, 45, 600))
  })
})
