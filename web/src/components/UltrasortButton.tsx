import { useEffect, useRef } from "react"
import { Keyboard } from "lucide-react"
import { ultraCss } from "@/lib/ultrasort"
import { cn } from "@/lib/utils"

/** 4x4 Bayer ordered-dither matrix, normalised to [0, 1). */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const

const CELL_CSS = 3
const FLOOD_MS = 250
const HOVER_MS = 150
const MIN_DENSITY = 0.05
const MAX_DENSITY = 0.55
const HOVER_DENSITY_BOOST = 0.3
const TWINKLE_AMPLITUDE = 0.12

/** Deterministic pseudo-random value in [0, 1) for a grid cell; stable across frames. */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Violet ordered-dither canvas background for the button, sparse-to-dense left to right.
 * Floods to solid Ultrasort violet once `pressed` and stays there.
 */
export function UltrasortButton({
  onPress,
  pressed,
  disabled = false,
  reducedMotion = false,
  className,
}: {
  onPress: () => void
  pressed: boolean
  disabled?: boolean
  reducedMotion?: boolean
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ width: 0, height: 0 })
  const activeTargetRef = useRef(0)
  const activeTRef = useRef(0)
  const pressedAtRef = useRef<number | null>(null)
  const floodedRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number | null>(null)

  // Keep latest reducedMotion in a ref so the draw loop (started once) reads current value.
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion

  const draw = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const { width, height } = sizeRef.current
    if (width <= 0 || height <= 0) return

    const rm = reducedMotionRef.current
    const now = performance.now()
    const floodT = floodedRef.current
      ? 1
      : pressedAtRef.current == null
        ? 0
        : rm
          ? 1
          : clamp01((now - pressedAtRef.current) / FLOOD_MS)
    if (floodT >= 1) floodedRef.current = true

    ctx.fillStyle = ultraCss(0.28)
    ctx.fillRect(0, 0, width, height)

    if (floodT >= 1) {
      ctx.fillStyle = ultraCss()
      ctx.fillRect(0, 0, width, height)
      return
    }

    const cols = Math.ceil(width / CELL_CSS)
    const rows = Math.ceil(height / CELL_CSS)
    const activeT = activeTRef.current
    const timeSec = now / 1000

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const xFrac = cols <= 1 ? 0.5 : x / (cols - 1)
        let density = lerp(MIN_DENSITY, MAX_DENSITY, xFrac)
        density = lerp(density, Math.min(1, density + HOVER_DENSITY_BOOST), activeT)
        density = lerp(density, 1, floodT)

        if (!rm) {
          const phase = hash2(x, y) * Math.PI * 2
          const period = 2 + hash2(x, y + 1) // 2-3s cycles
          const jitter = TWINKLE_AMPLITUDE * Math.sin((timeSec / period) * Math.PI * 2 + phase)
          density = clamp01(density + jitter)
        }

        const threshold = (BAYER4[y % 4][x % 4] + 0.5) / 16
        if (density <= threshold) continue

        const light = hash2(x + 0.5, y + 0.5) < 0.15
        ctx.fillStyle = light ? ultraCss(0.78) : ultraCss()
        ctx.fillRect(x * CELL_CSS, y * CELL_CSS, CELL_CSS, CELL_CSS)
      }
    }
  }

  const stopLoop = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    lastTimeRef.current = null
  }

  const ensureLoop = () => {
    if (reducedMotionRef.current || floodedRef.current || rafRef.current != null) return
    const step = (t: number) => {
      const last = lastTimeRef.current ?? t
      const dt = t - last
      lastTimeRef.current = t

      const target = activeTargetRef.current
      const rate = 1 - Math.exp(-dt / HOVER_MS)
      activeTRef.current = lerp(activeTRef.current, target, rate)

      draw()

      if (floodedRef.current) {
        rafRef.current = null
        lastTimeRef.current = null
        return
      }
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
  }

  // Resize observer: keep the canvas DPR-aware and crisp.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const cssWidth = entry.contentRect.width
      const cssHeight = entry.contentRect.height
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      canvas.width = Math.round(cssWidth * dpr)
      canvas.height = Math.round(cssHeight * dpr)
      const ctx = canvas.getContext("2d")
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      sizeRef.current = { width: cssWidth, height: cssHeight }
      draw()
    })
    observer.observe(canvas)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Twinkle loop: runs continuously until flooded, unless reduced motion.
  useEffect(() => {
    if (reducedMotion) {
      stopLoop()
      draw()
      return
    }
    ensureLoop()
    return stopLoop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion])

  // Flood on press.
  useEffect(() => {
    if (pressed) {
      if (pressedAtRef.current == null) pressedAtRef.current = performance.now()
      if (reducedMotion) {
        floodedRef.current = true
        draw()
      } else {
        ensureLoop()
      }
    } else {
      pressedAtRef.current = null
      floodedRef.current = false
      if (!reducedMotion) ensureLoop()
      else draw()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pressed, reducedMotion])

  useEffect(() => stopLoop, [])

  const setActive = (active: boolean) => {
    activeTargetRef.current = active ? 1 : 0
    if (reducedMotionRef.current) {
      activeTRef.current = activeTargetRef.current
      draw()
    } else {
      ensureLoop()
    }
  }

  return (
    <button
      type="button"
      aria-label="Ultrasort"
      disabled={disabled || pressed}
      onClick={() => {
        if (disabled || pressed) return
        onPress()
      }}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={(e) => {
        if (e.currentTarget.matches(":focus-visible")) setActive(true)
      }}
      onBlur={() => setActive(false)}
      className={cn(
        "group relative isolate inline-flex items-center gap-3 overflow-hidden rounded-xl px-5 py-3 text-[15px] font-semibold text-white shadow-md outline-none transition-[filter] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white disabled:cursor-default",
        !disabled && !pressed && "hover:brightness-110",
        className,
      )}
    >
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 -z-10 size-full" />
      Ultrasort
      <kbd
        aria-hidden="true"
        className="inline-flex items-center gap-1 rounded-md bg-white/20 px-1.5 py-0.5 font-mono text-[11px] font-medium"
      >
        <Keyboard className="size-3" />
        space
      </kbd>
    </button>
  )
}
