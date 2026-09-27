import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { along, clampCamera, easeInOut, MAX_ZOOM, OVERVIEW, pinchCamera, zoomAt, type MapCamera, type Point } from "@/lib/mapCamera"

/**
 * instant: follow the input 1:1 (trackpad, pinch, drag), committed once per frame.
 * glide: catch up quickly (mouse-wheel notches, buttons, keys).
 * fly: a timed ease-in-out (framing a category, reset).
 */
export type CameraMotion = "instant" | "glide" | "fly"

const GLIDE_MS = 90

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

  const move = useCallback((next: MapCamera, motion: CameraMotion = "fly") => {
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
    if (motion === "instant" || reducedRef.current) {
      current.current = target.current
      // Trackpads fire faster than the screen refreshes: render once per frame.
      frame.current = requestAnimationFrame(() => {
        setCamera(current.current)
        finish()
      })
      return
    }
    const from = current.current
    const to = target.current
    const started = performance.now()
    // Longer trips take a little longer, never sluggish.
    const trip = Math.abs(Math.log2(to.k / from.k)) + Math.hypot(to.tx - from.tx, to.ty - from.ty) / Math.max(width, height)
    const duration = Math.min(720, 320 + trip * 150)
    let previous = started
    const tick = (now: number) => {
      let done: boolean
      if (motion === "fly") {
        const t = Math.min(1, (now - started) / duration)
        current.current = t >= 1 ? to : along(from, to, easeInOut(t))
        done = t >= 1
      } else {
        const a = 1 - Math.exp(-Math.min(64, now - previous) / GLIDE_MS)
        previous = now
        const c = current.current
        done = Math.abs(Math.log(c.k / to.k)) < 0.0008 && Math.hypot(c.tx - to.tx, c.ty - to.ty) < 0.2
        current.current = done ? to : along(c, to, a)
      }
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
    move({ k: c.k, tx: old.width ? c.tx * width / old.width : 0, ty: old.height ? c.ty * height / old.height : 0 }, "instant")
  }, [width, height, move])

  useEffect(() => () => {
    cancelAnimationFrame(frame.current)
    clearTimeout(timeout.current)
  }, [])

  const zoom = useCallback((factor: number) => {
    const { width, height } = bounds.current
    exploreRef.current()
    move(zoomAt(current.current, { x: width / 2, y: height / 2 }, target.current.k * factor, width, height), "glide")
  }, [move])
  const reset = useCallback(() => move(OVERVIEW), [move])
  const pan = useCallback((dx: number, dy: number) => {
    exploreRef.current()
    move({ ...target.current, tx: target.current.tx + dx, ty: target.current.ty + dy }, "glide")
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
      // A mouse wheel clicks in big notches; a trackpad streams small deltas that should track the fingers.
      const notch = !e.ctrlKey && (e.deltaMode !== 0 || Math.abs(delta) >= 50)
      const factor = Math.exp(-Math.max(-150, Math.min(150, delta)) * (e.ctrlKey ? 0.012 : notch ? 0.003 : 0.0022))
      // Anchor on what is on screen now, so the point under the cursor stays put even mid-glide.
      const base = notch ? target.current.k : current.current.k
      move(zoomAt(current.current, local(e), base * factor, width, height), notch ? "glide" : "instant")
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
        move(pinchCamera(pinch.camera, pinch.midpoint, p.midpoint, p.distance / pinch.distance, width, height), "instant")
      } else if (start) {
        const p = local(e)
        const dx = p.x - start.x
        const dy = p.y - start.y
        if (Math.hypot(dx, dy) > 5) {
          suppressClick.current = true
          if (gestureCamera.k > 1.001) {
            exploreRef.current()
            setDragging(true)
            move({ ...gestureCamera, tx: gestureCamera.tx + dx, ty: gestureCamera.ty + dy }, "instant")
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
