import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { clampCamera, MAX_ZOOM, OVERVIEW, pinchCamera, zoomAt, type MapCamera, type Point } from "@/lib/mapCamera"

/** One animated camera drives geometry AND labels; no competing CSS transform. */
export function useMapCamera(width: number, height: number, reduced: boolean, onExplore: () => void) {
  const surfaceRef = useRef<SVGSVGElement>(null)
  const [camera, setCamera] = useState<MapCamera>(OVERVIEW)
  const [interacting, setInteracting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const current = useRef(camera)
  const target = useRef(camera)
  const frame = useRef(0)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const suppressClick = useRef(false)
  const bounds = useRef({ width, height })
  const reducedRef = useRef(reduced)
  const exploreRef = useRef(onExplore)
  useLayoutEffect(() => {
    reducedRef.current = reduced
    exploreRef.current = onExplore
  }, [reduced, onExplore])
  const surfaceReady = width > 40 && height > 40

  const move = useCallback((next: MapCamera, immediate = false) => {
    const { width, height } = bounds.current
    if (!width || !height) return
    target.current = clampCamera(next, width, height)
    cancelAnimationFrame(frame.current)
    clearTimeout(timeout.current)
    setInteracting(true)
    const finish = () => {
      frame.current = 0
      timeout.current = setTimeout(() => setInteracting(false), 140)
    }
    if (immediate || reducedRef.current) {
      current.current = target.current
      setCamera(target.current)
      finish()
      return
    }
    let previous = performance.now()
    const tick = (now: number) => {
      const a = 1 - Math.exp(-Math.min(64, now - previous) / 75)
      previous = now
      const c = current.current
      const t = target.current
      const done = Math.abs(c.k - t.k) < 0.0005 && Math.hypot(c.tx - t.tx, c.ty - t.ty) < 0.15
      current.current = done ? t : { k: c.k + (t.k - c.k) * a, tx: c.tx + (t.tx - c.tx) * a, ty: c.ty + (t.ty - c.ty) * a }
      setCamera(current.current)
      if (done) finish()
      else frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [])

  useEffect(() => {
    const old = bounds.current
    bounds.current = { width, height }
    // Preserve the visible world centre across a responsive resize.
    const c = target.current
    move({ k: c.k, tx: old.width ? c.tx * width / old.width : 0, ty: old.height ? c.ty * height / old.height : 0 }, true)
  }, [width, height, move])

  useEffect(() => () => {
    cancelAnimationFrame(frame.current)
    clearTimeout(timeout.current)
  }, [])

  const zoom = useCallback((factor: number) => {
    const { width, height } = bounds.current
    exploreRef.current()
    move(zoomAt(target.current, { x: width / 2, y: height / 2 }, target.current.k * factor, width, height))
  }, [move])
  const reset = useCallback(() => move(OVERVIEW), [move])
  const pan = useCallback((dx: number, dy: number) => {
    exploreRef.current()
    move({ ...target.current, tx: target.current.tx + dx, ty: target.current.ty + dy })
  }, [move])

  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const pointers = new Map<number, Point>()
    let start: Point | null = null
    let gestureCamera = OVERVIEW
    let pinch: { midpoint: Point; distance: number; camera: MapCamera } | null = null
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const pair = () => {
      const [a, b] = [...pointers.values()]
      return { midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) }
    }
    const wheel = (e: WheelEvent) => {
      // Native trackpad pinch arrives as ctrl+wheel in Chromium.
      if (e.metaKey) return
      e.preventDefault()
      exploreRef.current()
      const { width, height } = bounds.current
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1)
      const factor = Math.exp(-Math.max(-120, Math.min(120, delta)) * (e.ctrlKey ? 0.009 : 0.0035))
      move(zoomAt(target.current, local(e), target.current.k * factor, width, height))
    }
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return
      pointers.set(e.pointerId, local(e))
      // Capture on the hit node so a stationary tap still clicks that node.
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      if (pointers.size === 1) {
        suppressClick.current = false
        start = local(e)
        gestureCamera = current.current
      } else if (pointers.size === 2) {
        pinch = { ...pair(), camera: current.current }
        suppressClick.current = true
      }
    }
    const pointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, local(e))
      const { width, height } = bounds.current
      if (pointers.size >= 2 && pinch) {
        exploreRef.current()
        const p = pair()
        setDragging(true)
        move(pinchCamera(pinch.camera, pinch.midpoint, p.midpoint, p.distance / pinch.distance, width, height), true)
      } else if (start) {
        const p = local(e)
        const dx = p.x - start.x
        const dy = p.y - start.y
        if (Math.hypot(dx, dy) > 5) {
          suppressClick.current = true
          if (gestureCamera.k > 1.001) {
            exploreRef.current()
            setDragging(true)
            move({ ...gestureCamera, tx: gestureCamera.tx + dx, ty: gestureCamera.ty + dy }, true)
          }
        }
      }
    }
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      pinch = null
      if (pointers.size === 1) {
        start = [...pointers.values()][0]
        gestureCamera = current.current
      } else if (!pointers.size) {
        start = null
        setDragging(false)
      }
    }
    const click = (e: MouseEvent) => {
      if (suppressClick.current && e.detail !== 0) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    el.addEventListener("wheel", wheel, { passive: false })
    el.addEventListener("pointerdown", down)
    el.addEventListener("pointermove", pointerMove)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", up)
    el.addEventListener("lostpointercapture", up)
    el.addEventListener("click", click, true)
    return () => {
      el.removeEventListener("wheel", wheel)
      el.removeEventListener("pointerdown", down)
      el.removeEventListener("pointermove", pointerMove)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", up)
      el.removeEventListener("lostpointercapture", up)
      el.removeEventListener("click", click, true)
    }
  }, [move, surfaceReady])

  return { ...camera, surfaceRef, move, zoom, pan, reset, interacting, dragging, canZoomIn: camera.k < MAX_ZOOM - 0.01 }
}
