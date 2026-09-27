export type MapCamera = { k: number; tx: number; ty: number }
export type Point = { x: number; y: number }

export const OVERVIEW: MapCamera = { k: 1, tx: 0, ty: 0 }
export const MAX_ZOOM = 8

export function clampCamera(camera: MapCamera, width: number, height: number): MapCamera {
  const k = Math.max(1, Math.min(MAX_ZOOM, camera.k))
  return {
    k,
    tx: Math.max(width * (1 - k), Math.min(0, camera.tx)),
    ty: Math.max(height * (1 - k), Math.min(0, camera.ty)),
  }
}

/** Keep the world point under the cursor stationary while changing scale. */
export function zoomAt(camera: MapCamera, point: Point, scale: number, width: number, height: number): MapCamera {
  const k = Math.max(1, Math.min(MAX_ZOOM, scale))
  const ratio = k / camera.k
  return clampCamera({ k, tx: point.x - (point.x - camera.tx) * ratio, ty: point.y - (point.y - camera.ty) * ratio }, width, height)
}

/** Translate the pinch midpoint as well as its distance (two-finger panning). */
export function pinchCamera(camera: MapCamera, from: Point, to: Point, ratio: number, width: number, height: number): MapCamera {
  const k = Math.max(1, Math.min(MAX_ZOOM, camera.k * ratio))
  return clampCamera({ k, tx: to.x - (from.x - camera.tx) * k / camera.k, ty: to.y - (from.y - camera.ty) * k / camera.k }, width, height)
}

export function smoothStep(start: number, end: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)))
  return t * t * (3 - 2 * t)
}

/** Each category reveals its children when it occupies enough of the viewport. */
export function categoryDetail(k: number, radius: number, viewport: number): number {
  const revealAt = Math.max(1.65, Math.min(4.8, viewport * 0.82 / (2 * radius)))
  return smoothStep(1.08, revealAt, k)
}
