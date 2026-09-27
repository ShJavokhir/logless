export type MapCamera = { k: number; tx: number; ty: number }
export type Point = { x: number; y: number }

export const OVERVIEW: MapCamera = { k: 1, tx: 0, ty: 0 }
export const MAX_ZOOM = 12

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

/**
 * The camera a fraction `u` of the way from `from` to `to`, moving the way a
 * zoom looks natural: scale changes geometrically (each step feels the same
 * size) about the one screen point both cameras agree on, so nothing slides
 * sideways. Without a scale change it is a straight pan.
 */
export function along(from: MapCamera, to: MapCamera, u: number): MapCamera {
  const r = to.k / from.k
  if (Math.abs(r - 1) < 1e-6) return { k: to.k, tx: from.tx + (to.tx - from.tx) * u, ty: from.ty + (to.ty - from.ty) * u }
  const px = (to.tx - r * from.tx) / (1 - r)
  const py = (to.ty - r * from.ty) / (1 - r)
  const s = Math.pow(r, u)
  return { k: from.k * s, tx: px + (from.tx - px) * s, ty: py + (from.ty - py) * s }
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
