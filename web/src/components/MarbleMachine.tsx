import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Keyboard, Radio, ShieldCheck } from "lucide-react"
import type { IntakeVisual, useIntake } from "@/hooks/useIntake"
import { useElementSize } from "@/hooks/useElementSize"
import { createIntakeFlights, flowRows, flowStep } from "@/lib/intakeFlow"
import { observedSignals, type Pt } from "@/lib/intake"
import { fmtInt } from "@/lib/format"
import { signalName } from "@/lib/colors"
import type { SnapshotIndex } from "@/lib/snapshot"
import type { IntakeEvent, Signal } from "@/lib/types"
import { cn } from "@/lib/utils"

type Intake = ReturnType<typeof useIntake>

const STEPS = ["Read by GLM (earlier)", "Jev sorts", "Privacy gate", "Publish"]
const PAD = 22
const GATE_W = 74
const GATE_H = 50
const RAIL_SLOPE = 0.045
const GRAVITY = 0.0032 // px/ms²
const observed = (event: IntakeEvent) => Object.values(event.friction).includes("observed")
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const smooth = (t: number) => t * t * (3 - 2 * t)
const hash = (n: number) => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

// ------------------------------------------------------------------ geometry

type Box = { x: number; y: number; w: number; h: number }
type Geometry = {
  W: number
  H: number
  r: number
  jar: Box
  outlet: Pt
  gate: Pt
  railStart: number
  railEnd: number
  railY: (x: number) => number
  bins: (Box & { hole: number })[]
  queueSlots: number
}

function packed(box: Box, r: number, k: number, fromBottom = true): Pt {
  const d = 2 * r
  const per = Math.max(1, Math.floor((box.w - 4) / d))
  const pitch = d * 0.87
  let row = 0
  let left = k
  while (left >= (row % 2 ? per - 1 : per)) {
    left -= row % 2 ? per - 1 : per
    row++
  }
  const x = box.x + 2 + r + (row % 2 ? r : 0) + left * d
  const y = fromBottom ? box.y + box.h - r - 1 - row * pitch : box.y + r + row * pitch
  return { x, y }
}

/** Largest marble for which the whole batch fits in the jar and a quarter of it fits in the shortest bin. */
function geometry(W: number, H: number, total: number, nBins: number): Geometry {
  let g = layout(W, H, total, nBins, 9)
  for (let r = 9; r >= 1.75; r -= 0.25) {
    g = layout(W, H, total, nBins, r)
    const d = 2 * r
    const shortest = Math.min(...g.bins.map((b) => b.h))
    const perBin = Math.max(1, Math.floor((g.bins[0].w - 4) / d) - 0.5)
    const fitsBins = Math.floor((shortest - 2) / (d * 0.87)) * perBin >= total * 0.26
    if (g.jar.h <= H * 0.46 && fitsBins) break
  }
  return g
}

function layout(W: number, H: number, total: number, nBins: number, r: number): Geometry {
  const jarW = total > 600 ? clamp(W * 0.19, 170, 320) : clamp(W * 0.15, 170, 236)
  const d = 2 * r
  const per = Math.floor((jarW - 18) / d)
  const jarH = Math.ceil(total / Math.max(1, per - 0.5)) * d * 0.87 + d + 24
  const jar = { x: PAD, y: PAD + 26, w: jarW, h: jarH }
  const outlet = { x: jar.x + jar.w + 4, y: jar.y + jar.h - r - 8 }
  const gate = { x: jar.x + jar.w + clamp(W * 0.12, 130, 190), y: outlet.y + 58 }
  const railStart = gate.x + GATE_W / 2
  const railEnd = W - PAD
  const railY = (x: number) => gate.y + (x - gate.x) * RAIL_SLOPE
  const gap = 12
  const x0 = gate.x - 8
  const bw = (railEnd - x0 - gap * (nBins - 1)) / nBins
  const bottom = H - 104
  const bins = Array.from({ length: nBins }, (_, i) => {
    const x = x0 + i * (bw + gap)
    const hole = x + bw / 2
    const top = railY(hole) + r + 26
    return { x, y: top, w: bw, h: Math.max(40, bottom - top), hole }
  })
  const chute = Math.hypot(gate.x - GATE_W / 2 - outlet.x, gate.y - outlet.y)
  return { W, H, r, jar, outlet, gate, railStart, railEnd, railY, bins, queueSlots: Math.max(3, Math.floor(chute / (2 * r + 1.5))) }
}

// ------------------------------------------------------------------ marble sprites

type Tone = { key: string; hue: number; chroma: number; light: number; alpha?: number }
const hueOf = (color: string, fallback: number) => {
  const m = color.match(/oklch\(\s*[\d.]+\s+[\d.]+\s+([\d.]+)/)
  return m ? Number(m[1]) : fallback
}

function sprite(tone: Tone, r: number, dpr: number): HTMLCanvasElement {
  const size = Math.ceil((2 * r + 2) * dpr)
  const cv = document.createElement("canvas")
  cv.width = size
  cv.height = size
  const ctx = cv.getContext("2d")!
  ctx.scale(dpr, dpr)
  ctx.translate(r + 1, r + 1)
  const { hue: h, chroma: c, light: l } = tone
  ctx.globalAlpha = tone.alpha ?? 1
  const body = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r)
  body.addColorStop(0, `oklch(${Math.min(0.97, l + 0.3)} ${c * 0.45} ${h})`)
  body.addColorStop(0.5, `oklch(${l} ${c} ${h})`)
  body.addColorStop(1, `oklch(${Math.max(0.2, l - 0.22)} ${c * 0.9} ${h})`)
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fillStyle = body
  ctx.fill()
  // inner swirl, so rolling reads as rotation
  ctx.save()
  ctx.clip()
  ctx.globalAlpha = (tone.alpha ?? 1) * 0.55
  ctx.strokeStyle = `oklch(${Math.min(0.98, l + 0.28)} ${c * 0.5} ${h})`
  ctx.lineWidth = r * 0.34
  ctx.lineCap = "round"
  ctx.beginPath()
  ctx.arc(r * 0.18, r * 0.12, r * 0.52, 0.2, 2.5)
  ctx.stroke()
  ctx.globalAlpha = (tone.alpha ?? 1) * 0.35
  ctx.strokeStyle = `oklch(${Math.max(0.2, l - 0.25)} ${c} ${h})`
  ctx.lineWidth = r * 0.22
  ctx.beginPath()
  ctx.arc(-r * 0.1, r * 0.05, r * 0.6, 3.4, 5.2)
  ctx.stroke()
  ctx.restore()
  // rim + specular highlight
  ctx.globalAlpha = tone.alpha ?? 1
  ctx.strokeStyle = `oklch(${Math.max(0.15, l - 0.35)} ${c * 0.6} ${h} / 0.45)`
  ctx.lineWidth = 0.7
  ctx.beginPath()
  ctx.arc(0, 0, r - 0.35, 0, Math.PI * 2)
  ctx.stroke()
  const spec = ctx.createRadialGradient(-r * 0.38, -r * 0.42, 0, -r * 0.38, -r * 0.42, r * 0.42)
  spec.addColorStop(0, "rgba(255,255,255,0.95)")
  spec.addColorStop(1, "rgba(255,255,255,0)")
  ctx.fillStyle = spec
  ctx.beginPath()
  ctx.arc(-r * 0.38, -r * 0.42, r * 0.42, 0, Math.PI * 2)
  ctx.fill()
  return cv
}

// ------------------------------------------------------------------ component

/** One marble = one real conversation in the prepared batch; it leaves the queue when Jev's answer for it lands. */
export function MarbleMachine({
  intake,
  index,
  armed,
  onSort,
  action,
}: {
  intake: Intake
  index: SnapshotIndex
  armed: boolean
  onSort: () => void
  /** extra control beside the status badge (e.g. reset) */
  action?: React.ReactNode
}) {
  const [base] = useState(index)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { width, height } = useElementSize(boxRef)
  const rows = useMemo(() => flowRows(base, intake.landedEvents), [base, intake.landedEvents])
  const total = intake.counters?.total ?? intake.status?.batch_size ?? 0
  const filed = intake.landedEvents.length
  const friction = intake.landedEvents.filter(observed).length
  const step = armed ? 1 : flowStep(intake.stage, intake.published)
  const running = !armed && !intake.published
  const g = useMemo(() => (width > 0 && height > 0 ? geometry(width, height, Math.max(1, total), rows.length) : null), [width, height, total, rows.length])

  // Mutable machine state lives across renders; only the canvas reads it every frame.
  const bookRef = useRef<{
    reserved: number[]
    slotOf: Map<number, { bin: number; k: number }>
    landed: { event: IntakeEvent; bin: number; k: number; at: number }[]
    landedSeqs: Set<number>
    spawned: number
  } | null>(null)
  const live = useRef({ armed, published: intake.published, total, rowIds: rows.map((r) => r.node.id), g, filed: intake.landedEvents })
  useEffect(() => {
    live.current = { armed, published: intake.published, total, rowIds: rows.map((r) => r.node.id), g, filed: intake.landedEvents }
  })

  // Space sorts (the "snap"); ignored while typing.
  useEffect(() => {
    if (!armed) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.code === "Space" || e.key === "Enter") {
        e.preventDefault()
        onSort()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [armed, onSort])

  useEffect(() => {
    const cv = canvasRef.current
    const ctx = cv?.getContext("2d")
    if (!cv || !ctx || !g) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = Math.round(g.W * dpr)
    cv.height = Math.round(g.H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const { r } = g

    // sprites
    const tones = new Map<string, HTMLCanvasElement>()
    const tone = (t: Tone) => {
      let s = tones.get(t.key)
      if (!s) tones.set(t.key, (s = sprite(t, r, dpr)))
      return s
    }
    const glass = () => tone({ key: "glass", hue: 230, chroma: 0.012, light: 0.86 })
    const heat = () => tone({ key: "heat", hue: 38, chroma: 0.19, light: 0.64 })
    const binTone = (i: number) => {
      const node = base.byId.get(live.current.rowIds[i])
      if (!node || node.is_other) return tone({ key: "other", hue: 260, chroma: 0.02, light: 0.58 })
      const h = hueOf(base.paletteOf(node.id).dot, 250)
      return tone({ key: `h${h}`, hue: h, chroma: 0.15, light: 0.62 })
    }
    const binColor = (i: number) => {
      const node = base.byId.get(live.current.rowIds[i])
      return !node || node.is_other ? "oklch(0.6 0.02 260)" : `oklch(0.62 0.15 ${hueOf(base.paletteOf(node.id).dot, 250)})`
    }
    const binOf = (event: IntakeEvent) => {
      const ids = live.current.rowIds
      const parent = base.parentOf(event.leaf_id)
      let i = parent ? ids.indexOf(parent.id) : -1
      if (i < 0) i = ids.findIndex((id) => base.byId.get(id)?.is_other)
      return Math.max(0, i)
    }
    const colorSprite = (event: IntakeEvent, bin: number) => (observed(event) ? heat() : binTone(bin))

    // Bookkeeping survives effect restarts (a resize mid-run flushes flights into it); positions are re-derived from slots.
    if (!bookRef.current) bookRef.current = { reserved: g.bins.map(() => 0), slotOf: new Map(), landed: [], landedSeqs: new Set(), spawned: 0 }
    const book = bookRef.current
    const { reserved, slotOf, landed, landedSeqs } = book
    const reserve = (event: IntakeEvent) => {
      if (slotOf.has(event.seq)) return slotOf.get(event.seq)!
      const bin = binOf(event)
      const slot = { bin, k: reserved[bin]++ }
      slotOf.set(event.seq, slot)
      return slot
    }
    for (const event of intake.landedEvents) {
      if (landedSeqs.has(event.seq)) continue
      const s = reserve(event)
      landedSeqs.add(event.seq)
      landed.push({ event, ...s, at: -1e9 })
      book.spawned++
    }
    let queue: { s: number; v: number }[] = []
    let lastFeed = 0
    let flash = { color: "", at: -1e9 }
    let openedAt = live.current.armed ? Infinity : -1e9
    let publishedAt = live.current.published ? -1e9 : Infinity

    const chuteLen = Math.hypot(g.gate.x - GATE_W / 2 - g.outlet.x, g.gate.y - g.outlet.y)
    const chutePt = (s: number): Pt => {
      const t = s / chuteLen
      return { x: g.outlet.x + (g.gate.x - GATE_W / 2 - g.outlet.x) * t, y: g.outlet.y + (g.gate.y - g.outlet.y) * t }
    }

    // flight timing: through the gate, roll the rail, fall into the bin, one small bounce
    const THROUGH = 140
    const plan = (event: IntakeEvent) => {
      const { bin, k } = reserve(event)
      const b = g.bins[bin]
      const target = packed(b, r, k)
      const dist = Math.max(0, b.hole - g.railStart)
      const roll = clamp(dist / 1.35, 160, 820)
      const fallH = Math.max(1, target.y - g.railY(b.hole))
      const fall = Math.sqrt((2 * fallH) / GRAVITY)
      const bounce = 150
      return { bin, k, target, dist, roll, fall, fallH, bounce, total: THROUGH + roll + fall + bounce }
    }
    const plans = new Map<number, ReturnType<typeof plan>>()
    const visual: IntakeVisual = {
      ...intake.visual,
      onSpawn: (event) => {
        intake.visual.onSpawn(event)
        if (!plans.has(event.seq)) plans.set(event.seq, plan(event))
        book.spawned++
        queue.shift()
      },
      onLand: (event) => {
        const p = plans.get(event.seq) ?? plan(event)
        if (!landedSeqs.has(event.seq)) {
          landedSeqs.add(event.seq)
          const m = { event, bin: p.bin, k: p.k, at: performance.now() }
          landed.push(m)
          settle(m)
        }
        plans.delete(event.seq)
        intake.visual.onLand(event)
      },
    }
    const flights = createIntakeFlights(visual, (event) => (plans.get(event.seq) ?? plan(event)).total)

    const drawOn = (c: CanvasRenderingContext2D, s: HTMLCanvasElement, p: Pt, angle = 0, alpha = 1) => {
      const size = 2 * r + 2
      c.globalAlpha = alpha
      if (angle) {
        c.save()
        c.translate(p.x, p.y)
        c.rotate(angle)
        c.drawImage(s, -size / 2, -size / 2, size, size)
        c.restore()
      } else c.drawImage(s, p.x - size / 2, p.y - size / 2, size, size)
      c.globalAlpha = 1
    }
    const draw = (s: HTMLCanvasElement, p: Pt, angle = 0, alpha = 1) => drawOn(ctx, s, p, angle, alpha)
    const spin = r >= 4 // tiny marbles skip per-marble rotation
    // Marbles at rest are painted once into their own layer, so thousands cost one drawImage per frame.
    const settledCv = document.createElement("canvas")
    settledCv.width = cv.width
    settledCv.height = cv.height
    const settledCtx = settledCv.getContext("2d")!
    settledCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const settle = (m: { event: IntakeEvent; bin: number; k: number }) => {
      const b = g.bins[m.bin]
      if (!b) return
      const p = packed(b, r, m.k)
      drawOn(settledCtx, colorSprite(m.event, m.bin), { x: p.x + (hash(m.event.seq) - 0.5) * 0.9, y: p.y }, spin ? hash(m.event.seq) * 6 : 0)
    }
    for (const m of landed) settle(m)
    const shadow = (p: Pt, a = 0.16) => {
      ctx.fillStyle = `rgba(20,24,33,${a})`
      ctx.beginPath()
      ctx.ellipse(p.x + 1, p.y + r * 0.9, r * 0.85, r * 0.3, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    const roundRect = (b: Box, rad: number) => {
      ctx.beginPath()
      ctx.roundRect(b.x, b.y, b.w, b.h, rad)
    }
    const steel = (x1: number, y1: number, x2: number, y2: number, w: number, a = 1) => {
      ctx.globalAlpha = a
      ctx.lineCap = "round"
      ctx.strokeStyle = "oklch(0.55 0.01 250)"
      ctx.lineWidth = w + 1
      ctx.beginPath()
      ctx.moveTo(x1, y1 + 0.5)
      ctx.lineTo(x2, y2 + 0.5)
      ctx.stroke()
      ctx.strokeStyle = "oklch(0.86 0.005 250)"
      ctx.lineWidth = w * 0.45
      ctx.beginPath()
      ctx.moveTo(x1, y1 - w * 0.2)
      ctx.lineTo(x2, y2 - w * 0.2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    let raf = 0
    let prev = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(48, now - prev)
      prev = now
      const L = live.current
      if (!L.armed && openedAt === Infinity) openedAt = now
      if (L.published && publishedAt === Infinity) publishedAt = now
      const active = L.armed ? [] : flights.tick(now)
      // Catch up on anything the hook filed while frames were paused (hidden tab): no flight, straight to its slot.
      if (L.filed.length > landedSeqs.size) {
        for (const event of L.filed) {
          if (landedSeqs.has(event.seq) || plans.has(event.seq)) continue
          const m = { event, ...reserve(event), at: now }
          landedSeqs.add(event.seq)
          landed.push(m)
          settle(m)
          book.spawned++
        }
      }
      ctx.clearRect(0, 0, g.W, g.H)

      // ---- jar (the prepared batch)
      const inQueue = queue.length
      const jarCount = Math.max(0, L.total - book.spawned - inQueue)
      const jarInner = { x: g.jar.x + 7, y: g.jar.y + 18, w: g.jar.w - 14, h: g.jar.h - 24 }
      ctx.fillStyle = "oklch(0.975 0.004 250 / 0.9)"
      roundRect(g.jar, 18)
      ctx.fill()
      for (let k = 0; k < jarCount; k++) {
        const p = packed(jarInner, r, k)
        draw(glass(), { x: p.x + (hash(k) - 0.5) * Math.min(1.8, r * 0.25), y: p.y + (hash(k + 7777) - 0.5) * Math.min(1.2, r * 0.18) }, spin ? hash(k + 99) * 6 : 0)
      }
      // glass jar walls + lid
      const wall = ctx.createLinearGradient(g.jar.x, 0, g.jar.x + g.jar.w, 0)
      wall.addColorStop(0, "rgba(255,255,255,0.55)")
      wall.addColorStop(0.12, "rgba(255,255,255,0.05)")
      wall.addColorStop(0.85, "rgba(255,255,255,0)")
      wall.addColorStop(1, "rgba(255,255,255,0.35)")
      ctx.fillStyle = wall
      roundRect(g.jar, 18)
      ctx.fill()
      ctx.strokeStyle = "oklch(0.8 0.01 250)"
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.fillStyle = "oklch(0.68 0.09 75)"
      roundRect({ x: g.jar.x + 10, y: g.jar.y - 14, w: g.jar.w - 20, h: 16 }, 5)
      ctx.fill()
      ctx.fillStyle = "oklch(0.8 0.08 80)"
      ctx.fillRect(g.jar.x + 14, g.jar.y - 11, g.jar.w - 28, 3)

      // ---- chute: marbles trickle from the jar and wait at Jev's gate
      const gateIn = g.gate.x - GATE_W / 2
      steel(g.outlet.x - 6, g.outlet.y + r + 1, gateIn + 4, g.gate.y + r + 1, 3)
      const remaining = Math.max(0, L.total - book.spawned)
      const want = Math.min(g.queueSlots, remaining)
      const refill = L.armed ? clamp(r * 36, 70, 260) : 12
      if (queue.length < want && now - lastFeed > refill && (queue.length === 0 || queue[queue.length - 1].s > 2 * r + 2)) {
        queue.push({ s: 0, v: L.armed ? 0.05 : 0.5 })
        lastFeed = now
      }
      if (queue.length > want) queue = queue.slice(0, want)
      queue.forEach((m, i) => {
        const stop = chuteLen - r - i * (2 * r + 1.2)
        if (m.s < stop) {
          m.v = Math.min(L.armed ? 0.32 : 1.6, m.v + (L.armed ? 0.0009 : 0.01) * dt)
          m.s = Math.min(stop, m.s + m.v * dt)
        } else {
          m.s = stop
          m.v = 0
        }
        const p = chutePt(m.s)
        draw(glass(), p, m.s / r)
      })
      steel(g.outlet.x - 6, g.outlet.y - r - 1, gateIn + 4, g.gate.y - r - 1, 2, 0.55)

      // ---- rail + holes
      steel(g.railStart - 6, g.railY(g.railStart) - r - 1, g.railEnd, g.railY(g.railEnd) - r - 1, 2, 0.55)

      // ---- bins
      g.bins.forEach((b, i) => {
        const node = base.byId.get(L.rowIds[i])
        const pal = base.paletteOf(L.rowIds[i])
        ctx.fillStyle = pal.fill
        roundRect(b, 10)
        ctx.fill()
        ctx.strokeStyle = pal.stroke
        ctx.lineWidth = 1.25
        ctx.setLineDash(node?.is_other ? [5, 4] : [])
        ctx.stroke()
        ctx.setLineDash([])
        const pub = clamp((now - publishedAt - i * 70) / 500, 0, 1)
        if (pub > 0) {
          ctx.save()
          ctx.shadowColor = binColor(i)
          ctx.shadowBlur = 16 * pub
          ctx.strokeStyle = binColor(i)
          ctx.globalAlpha = 0.35 + 0.5 * pub
          ctx.lineWidth = 2
          roundRect(b, 10)
          ctx.stroke()
          ctx.restore()
        }
        // drop peg over the hole
        ctx.strokeStyle = binColor(i)
        ctx.lineWidth = 2
        ctx.beginPath()
        const hy = g.railY(b.hole)
        ctx.moveTo(b.hole - r - 3, hy + r + 5)
        ctx.lineTo(b.hole - r - 3, hy + r + 16)
        ctx.moveTo(b.hole + r + 3, hy + r + 5)
        ctx.lineTo(b.hole + r + 3, hy + r + 16)
        ctx.stroke()
      })
      // landed marbles
      ctx.drawImage(settledCv, 0, 0, g.W, g.H)

      // ---- flights
      let lastOut: { color: string; at: number } | null = null
      for (const { event, start } of active) {
        const p = plans.get(event.seq)
        if (!p) continue
        const t = now - start
        const b = g.bins[p.bin]
        let pos: Pt
        let angle = 0
        let spriteOf = colorSprite(event, p.bin)
        if (t < THROUGH) {
          const x = gateIn - r + (GATE_W + 2 * r) * (t / THROUGH)
          pos = { x, y: g.gate.y }
          if (t < THROUGH / 2) spriteOf = glass()
          else lastOut = { color: binColor(p.bin), at: start + THROUGH / 2 }
        } else if (t < THROUGH + p.roll) {
          const k = (t - THROUGH) / p.roll
          const e = k < 0.5 ? smooth(k) * 0.9 + k * 0.1 : k
          const x = g.railStart + p.dist * e
          pos = { x, y: g.railY(x) }
          angle = (x - g.railStart) / r
          shadow(pos, 0.1)
        } else if (t < THROUGH + p.roll + p.fall) {
          const k = (t - THROUGH - p.roll) / p.fall
          const tf = t - THROUGH - p.roll
          const y0 = g.railY(b.hole)
          pos = { x: b.hole + (p.target.x - b.hole) * smooth(k), y: Math.min(p.target.y, y0 + 0.5 * GRAVITY * tf * tf) }
          angle = p.dist / r + k * 2
        } else {
          const k = clamp((t - THROUGH - p.roll - p.fall) / p.bounce, 0, 1)
          const hop = Math.min(10, p.fallH * 0.08) * 4 * k * (1 - k)
          pos = { x: p.target.x, y: p.target.y - hop }
          angle = p.dist / r + 2
        }
        draw(spriteOf, pos, angle)
      }
      if (lastOut) flash = lastOut

      // front rail (drawn over rolling marbles)
      steel(g.railStart - 6, g.railY(g.railStart) + r + 1, g.railEnd, g.railY(g.railEnd) + r + 1, 3)

      // ---- Jev gate
      const gb = { x: g.gate.x - GATE_W / 2, y: g.gate.y - GATE_H / 2, w: GATE_W, h: GATE_H }
      const glow = clamp(1 - (now - flash.at) / 260, 0, 1)
      if (glow > 0 && flash.color) {
        ctx.save()
        ctx.shadowColor = flash.color
        ctx.shadowBlur = 22 * glow
        ctx.fillStyle = flash.color
        roundRect(gb, 12)
        ctx.fill()
        ctx.restore()
      }
      const body = ctx.createLinearGradient(0, gb.y, 0, gb.y + gb.h)
      body.addColorStop(0, "oklch(0.3 0.03 262)")
      body.addColorStop(1, "oklch(0.2 0.025 262)")
      ctx.fillStyle = body
      roundRect(gb, 12)
      ctx.fill()
      ctx.strokeStyle = glow > 0 && flash.color ? flash.color : "oklch(0.45 0.05 262)"
      ctx.lineWidth = 1.5 + glow
      ctx.stroke()
      ctx.fillStyle = "white"
      ctx.font = "600 17px 'Geist Variable', system-ui, sans-serif"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("Jev", g.gate.x, g.gate.y - 5)
      // status LEDs
      for (let i = 0; i < 5; i++) {
        const on = !L.armed && (glow > 0.15 ? (i + Math.floor(now / 70)) % 2 === 0 : false)
        ctx.fillStyle = on ? (flash.color || "white") : L.armed ? "oklch(0.72 0.14 75)" : "oklch(0.42 0.03 262)"
        if (L.armed) ctx.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(now / 520 + i * 0.5))
        ctx.beginPath()
        ctx.arc(g.gate.x - 16 + i * 8, g.gate.y + 13, 2.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }
      const lift = clamp((now - openedAt) / 260, 0, 1)
      if (lift < 1) {
        // closed gate bar; it lifts away on the snap
        ctx.globalAlpha = 1 - lift
        ctx.fillStyle = "oklch(0.72 0.14 75)"
        roundRect({ x: gateIn - 3, y: g.gate.y - r - 5 - lift * 28, w: 3, h: 2 * r + 10 }, 1.5)
        ctx.fill()
        ctx.globalAlpha = 1
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      flights.flush()
    }
    // geometry changes (resize) restart the machine; landed marbles are re-seeded from the hook
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, base, intake.visual])

  const jevDecisions = filed * (intake.counters?.decisions_per_conversation ?? 5)
  const hudLeft = g ? g.gate.x - GATE_W / 2 - 8 : 260

  return (
    <section aria-label="Live intake sorting machine" className="intake-flow absolute inset-0 z-20 flex flex-col overflow-hidden bg-card">
      <div ref={boxRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0" style={{ width, height }} />
        {g ? (
          <>
            {/* jar caption */}
            <div className="absolute text-[11.5px]" style={{ left: g.jar.x, top: PAD - 16, width: g.jar.w }}>
              <span className="font-medium">New conversations</span>
              <span className="float-right font-mono tabular-nums text-muted-foreground">{fmtInt(Math.max(0, total - filed))}</span>
            </div>
            <div className="absolute text-[11px] leading-snug text-muted-foreground" style={{ left: g.jar.x, top: g.jar.y + g.jar.h + 14, width: g.jar.w + 40 }}>
              <p className="font-medium text-foreground">{fmtInt(total)} real WildChat conversations</p>
              <p>One marble = one conversation.</p>
            </div>

            {/* HUD */}
            <div className="absolute flex flex-col gap-4" style={{ left: hudLeft, top: PAD - 6, right: PAD }}>
              <header className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="text-[22px] font-semibold tracking-tight">
                  {fmtInt(total)} conversations → {rows.length} workflows
                </h2>
                <span className="flex shrink-0 items-center gap-2">
                {action}
                <span className={cn("mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium", intake.published ? "bg-ok-soft text-ok" : armed ? "bg-muted text-muted-foreground" : "bg-brand-soft text-brand")}>
                  {intake.published ? <Check className="size-3.5" /> : <Radio className={cn("size-3.5", running && "animate-pulse")} />}
                  {intake.published ? "Published" : armed ? "Ready" : "Live"}
                </span>
                </span>
              </header>
              <ol aria-label="Classification stages" className="flex flex-wrap gap-1.5">
                {STEPS.map((label, i) => (
                  <li key={label} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px]", i === step && !armed ? "bg-brand text-white" : i < step ? "text-foreground" : "text-subtle")}>
                    <span className={cn("grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px]", i === step && !armed ? "bg-white/20" : "bg-muted")}>
                      {i < step ? <Check className="size-3" /> : `0${i + 1}`}
                    </span>
                    {label}
                  </li>
                ))}
              </ol>
              {armed ? (
                <div className="flex flex-wrap items-center gap-4">
                  <button
                    type="button"
                    onClick={onSort}
                    className="group inline-flex items-center gap-3 rounded-xl bg-brand px-5 py-3 text-[15px] font-semibold text-white shadow-md transition hover:brightness-110"
                  >
                    <span className="relative flex size-2.5">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/70" />
                      <span className="relative inline-flex size-2.5 rounded-full bg-white" />
                    </span>
                    Sort with Jev
                    <kbd className="inline-flex items-center gap-1 rounded-md bg-white/20 px-1.5 py-0.5 font-mono text-[11px] font-medium">
                      <Keyboard className="size-3" />
                      space
                    </kbd>
                  </button>
                  <p className="max-w-[360px] text-[12px] leading-snug text-muted-foreground">
                    Jev makes {intake.counters?.decisions_per_conversation ?? 5} decisions per conversation: its workflow, plus friction signals. Each marble drops the moment its real answer lands.
                  </p>
                </div>
              ) : (
                <dl className="grid max-w-[720px] grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                  <Stat label="Sorted" value={`${fmtInt(filed)} / ${fmtInt(total)}`} testId="flow-filed" />
                  <Stat label="Jev decisions" value={fmtInt(jevDecisions)} />
                  <Stat label="Conversations / s" value={intake.counters?.per_second ? intake.counters.per_second.toFixed(0) : "—"} />
                  <Stat label="Median Jev call" value={intake.counters?.p50_ms ? `${fmtInt(intake.counters.p50_ms)} ms` : "—"} />
                </dl>
              )}
              {!armed ? (
                <div aria-live="off" className="max-w-[720px]">
                  <p className="mb-1 text-[11.5px] font-medium text-muted-foreground">Latest decisions</p>
                  {intake.feed.length ? (
                    <ul className="flex flex-col gap-0.5">
                      {intake.feed.slice(0, 3).map((ev, i) => {
                        const node = base.byId.get(ev.leaf_id)
                        const signals = observedSignals(ev)
                        return (
                          <li key={ev.seq} className={cn("flex items-center gap-2 truncate text-[12.5px] transition-opacity", i === 0 ? "opacity-100" : i === 1 ? "opacity-60" : "opacity-35")}>
                            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: signals.length ? "var(--heat)" : base.paletteOf(ev.leaf_id).dot }} />
                            <span className="font-medium">{node?.short_title ?? node?.title ?? "Other or unclear"}</span>
                            <span className="font-mono text-muted-foreground">p={ev.p.toFixed(2)}</span>
                            {signals.length ? <span className="text-heat">{signals.map((s) => signalName(s as Signal)).join(", ")}</span> : <span className="text-muted-foreground">no friction</span>}
                            <span className="text-subtle">{ev.language} · {ev.turns} turns</span>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p className="text-[12.5px] text-muted-foreground">Waiting for Jev's first answers…</p>
                  )}
                </div>
              ) : null}
            </div>

            {/* bin labels */}
            <ol aria-label="Conversations filed by workflow">
              {rows.map((row, i) => {
                const b = g.bins[i]
                if (!b) return null
                const rowFriction = row.events.filter(observed).length
                return (
                  <li key={row.node.id} data-flow-row={row.node.id} data-count={row.events.length} className="absolute text-center" style={{ left: b.x, top: b.y + b.h + 8, width: b.w }}>
                    <p className="truncate text-[12px] font-medium">{row.node.is_other ? "Other or unclear" : row.node.short_title ?? row.node.title}</p>
                    <p className="font-mono text-[18px] leading-tight font-semibold tabular-nums">+{row.events.length}</p>
                    <p className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                      {fmtInt(row.node.conversations)} → {fmtInt(row.node.conversations + row.events.length)}
                    </p>
                    <p className="font-mono text-[10.5px] tabular-nums">
                      {rowFriction ? <span className="text-heat">{rowFriction} friction</span> : row.node.is_other ? <span className="text-subtle">Jev p &lt; 0.65</span> : <span className="text-subtle">no friction</span>}
                    </p>
                  </li>
                )
              })}
            </ol>
          </>
        ) : null}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2 text-[11.5px] text-muted-foreground">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Legend className="bg-[oklch(0.86_0.012_230)]" label="not yet decided" />
          <Legend className="bg-brand" label="coloured by Jev's workflow" />
          <Legend className="bg-heat" label={`friction observed (${fmtInt(friction)})`} />
        </span>
        <span role="status" className={cn("flex items-center gap-1.5", intake.published && "text-ok")}>
          <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
          {armed
            ? "Nothing sent yet. Press space to start the live run."
            : intake.published
              ? "Privacy gate passed. Returning to the updated map…"
              : step >= 3
                ? "Privacy gate passed. Publishing the aggregate map…"
                : step === 2
                  ? "Checking the aggregate map at the privacy gate…"
                  : "Counts are aggregates only; no conversation text leaves the pipeline."}
        </span>
      </footer>
    </section>
  )
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <dt className="text-[10.5px] tracking-wide text-subtle uppercase">{label}</dt>
      <dd data-testid={testId} className="font-mono text-[20px] leading-tight font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("size-2.5 rounded-full", className)} />
      {label}
    </span>
  )
}
