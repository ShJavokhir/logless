import { useEffect, useMemo, useRef } from "react"
import { Inbox } from "lucide-react"
import type { IntakeVisual } from "@/hooks/useIntake"
import { arcControl, bezier, easeInOutCubic, easeOutCubic, flightMs, pickInboxCorner, type Pt } from "@/lib/intake"
import { fmtInt } from "@/lib/format"
import type { IntakeEvent } from "@/lib/types"

type Target = { x: number; y: number; r: number }

type Dot = { ev: IntakeEvent; from: Pt; ctrl: Pt; to: Pt; start: number; dur: number; color: string; friction: boolean; target: Target }
type Pulse = { x: number; y: number; r: number; start: number; color: string }

const HEAT = "oklch(0.6 0.15 40)"
const PULSE_MS = 650

/**
 * Canvas layer over the map: each decided conversation leaves the inbox as a
 * dot, arcs into its workflow circle, and the circle pulses as it lands.
 * Drawing happens in requestAnimationFrame; React only re-renders at ~10 Hz.
 */
export function IntakeOverlay({
  visual,
  width,
  height,
  targetOf,
  colorOf,
  decided,
  total,
  obstacles,
}: {
  visual: IntakeVisual
  width: number
  height: number
  targetOf: (leafId: string) => Target | null
  colorOf: (leafId: string) => { dot: string; ring: string }
  decided: number
  total: number
  /** category circles in screen space, to keep the inbox badge off them */
  obstacles: { x: number; y: number; r: number }[]
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inbox = useMemo(() => pickInboxCorner(obstacles, width, height), [obstacles, width, height])
  const inboxRef = useRef<Pt>(inbox.origin)
  useEffect(() => {
    inboxRef.current = inbox.origin
  }, [inbox])
  const geo = useRef({ targetOf, colorOf })
  useEffect(() => {
    geo.current = { targetOf, colorOf }
  }, [targetOf, colorOf])

  useEffect(() => {
    const cv = canvasRef.current
    const ctx = cv?.getContext("2d")
    if (!cv || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = Math.round(width * dpr)
    cv.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const dots: Dot[] = []
    const pulses: Pulse[] = []
    const lastPulse = new Map<string, number>()
    const { scheduler, onSpawn, onLand, reducedMotion } = visual
    let raf = 0

    const pulseAt = (leafId: string, t: Target, color: string, now: number) => {
      if (reducedMotion) return
      if (now - (lastPulse.get(leafId) ?? 0) < 180) return
      lastPulse.set(leafId, now)
      pulses.push({ x: t.x, y: t.y, r: t.r, start: now, color })
    }

    const frame = (now: number) => {
      visual.heartbeat()
      const tick = scheduler.tick(now)
      for (const ev of tick.instant) {
        onSpawn(ev)
        onLand(ev)
        const t = geo.current.targetOf(ev.leaf_id)
        if (t) pulseAt(ev.leaf_id, t, geo.current.colorOf(ev.leaf_id).ring, now)
      }
      for (const ev of tick.spawn) {
        onSpawn(ev)
        const target = geo.current.targetOf(ev.leaf_id)
        if (!target) {
          onLand(ev)
          scheduler.land()
          continue
        }
        const a = Math.random() * Math.PI * 2
        const rr = Math.sqrt(Math.random()) * target.r * 0.45
        const to = { x: target.x + Math.cos(a) * rr, y: target.y + Math.sin(a) * rr }
        const o = inboxRef.current
        const from = { x: o.x + (Math.random() - 0.5) * 6, y: o.y + (Math.random() - 0.5) * 6 }
        dots.push({
          ev,
          from,
          to,
          ctrl: arcControl(from, to, 0.18 + Math.random() * 0.14),
          start: now,
          dur: flightMs(from, to) * (0.9 + Math.random() * 0.2),
          color: geo.current.colorOf(ev.leaf_id).dot,
          friction: Object.values(ev.friction).includes("observed"),
          target,
        })
      }

      ctx.clearRect(0, 0, width, height)

      // landing pulses
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i]
        const k = (now - p.start) / PULSE_MS
        if (k >= 1) {
          pulses.splice(i, 1)
          continue
        }
        const e = easeOutCubic(k)
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r + 1 + e * 9, 0, Math.PI * 2)
        ctx.strokeStyle = p.color
        ctx.globalAlpha = 0.5 * (1 - e)
        ctx.lineWidth = 2 - e * 1.4
        ctx.stroke()
      }

      // dots in flight
      for (let i = dots.length - 1; i >= 0; i--) {
        const d = dots[i]
        const k = (now - d.start) / d.dur
        if (k >= 1) {
          dots.splice(i, 1)
          scheduler.land()
          onLand(d.ev)
          pulseAt(d.ev.leaf_id, geo.current.targetOf(d.ev.leaf_id) ?? d.target, d.friction ? HEAT : geo.current.colorOf(d.ev.leaf_id).ring, now)
          continue
        }
        // short fading tail
        for (let j = 4; j >= 1; j--) {
          const kt = Math.max(0, k - j * 0.025)
          const q = bezier(d.from, d.ctrl, d.to, easeInOutCubic(kt))
          ctx.beginPath()
          ctx.arc(q.x, q.y, 3.2 - j * 0.5, 0, Math.PI * 2)
          ctx.fillStyle = d.color
          ctx.globalAlpha = 0.22 - j * 0.04
          ctx.fill()
        }
        const p = bezier(d.from, d.ctrl, d.to, easeInOutCubic(k))
        const fadeIn = Math.min(1, k * 6)
        ctx.globalAlpha = 0.95 * fadeIn
        ctx.beginPath()
        ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2)
        ctx.fillStyle = d.color
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = "rgba(255,255,255,0.9)"
        ctx.stroke()
        if (d.friction) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, 5.6, 0, Math.PI * 2)
          ctx.lineWidth = 1.7
          ctx.strokeStyle = HEAT
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      // anything still in the air is filed so counts and the scheduler stay exact
      for (const d of dots) {
        scheduler.land()
        onLand(d.ev)
      }
    }
  }, [visual, width, height])

  const remaining = Math.max(0, total - decided)
  return (
    <>
      <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0" style={{ width, height }} />
      <div
        className="pointer-events-none absolute z-10 flex h-7 items-center gap-1.5 rounded-full border bg-card/95 pr-2.5 pl-2 text-[11.5px] shadow-xs backdrop-blur-sm"
        style={{ left: inbox.left, top: inbox.top }}
      >
        <Inbox aria-hidden className="size-3.5 text-brand" />
        <span className="font-medium">New conversations</span>
        <span className="font-mono text-muted-foreground tabular-nums">
          {fmtInt(remaining)} waiting
        </span>
      </div>
    </>
  )
}
