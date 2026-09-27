import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Radio, ShieldCheck } from "lucide-react"
import type { useIntake } from "@/hooks/useIntake"
import { useElementSize } from "@/hooks/useElementSize"
import { createIntakeFlights, FLOW_FLIGHT_MS, flowRows, flowStep } from "@/lib/intakeFlow"
import { easeInOutCubic, type Pt } from "@/lib/intake"
import { fmtInt } from "@/lib/format"
import type { SnapshotIndex } from "@/lib/snapshot"
import type { IntakeEvent } from "@/lib/types"
import { cn } from "@/lib/utils"

type Intake = ReturnType<typeof useIntake>
const HEAT = "oklch(0.6 0.15 40)"
const STEPS = ["Pre-read by GLM", "Jev decides", "Privacy gate", "Publish"]
const observed = (event: IntakeEvent) => Object.values(event.friction).includes("observed")
const mix = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const curve = (a: Pt, b: Pt, t: number): Pt => {
  const u = 1 - t
  const mid = (a.x + b.x) / 2
  return { x: u ** 3 * a.x + 3 * u * u * t * mid + 3 * u * t * t * mid + t ** 3 * b.x, y: (u ** 3 + 3 * u * u * t) * a.y + (3 * u * t * t + t ** 3) * b.y }
}
const along = (points: Pt[], t: number): Pt => {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y))
  let distance = t * lengths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i]) return mix(points[i], points[i + 1], distance / (lengths[i] || 1))
    distance -= lengths[i]
  }
  return points[points.length - 1]
}

/** The rows retain the starting taxonomy/order throughout the publication hold. */
export function IntakeFlow({ intake, index }: { intake: Intake; index: SnapshotIndex }) {
  const [base] = useState(index)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { width } = useElementSize(boxRef)
  const rows = useMemo(() => flowRows(base, intake.landedEvents), [base, intake.landedEvents])
  const total = intake.counters?.total ?? intake.status?.batch_size ?? 0
  const decided = intake.counters?.decided ?? 0
  const filed = intake.landedEvents.length
  const friction = intake.landedEvents.filter(observed).length
  const step = flowStep(intake.stage, intake.published)
  const compact = width < 600
  const rowLeft = compact ? 54 : Math.round(width * 0.55)
  const rowTop = compact ? 178 : 34
  const rowWidth = Math.max(0, width - rowLeft - 12)
  const height = rowTop + rows.length * 51 + 12
  const inbox = { x: 12, y: compact ? 12 : 106, w: compact ? Math.max(122, width * 0.4) : Math.max(120, width * 0.22), h: compact ? 112 : 232 }
  const jev = { x: compact ? width * 0.73 : width * 0.385, y: compact ? 70 : 233 }
  const source = { x: inbox.x + inbox.w, y: inbox.y + inbox.h / 2 }
  const geo = useRef({ rows, total, decided, inbox, jev, source, rowLeft, rowTop, rowWidth })
  useEffect(() => {
    geo.current = { rows, total, decided, inbox, jev, source, rowLeft, rowTop, rowWidth }
  })

  useEffect(() => {
    const cv = canvasRef.current
    const ctx = cv?.getContext("2d")
    if (!cv || !ctx || width <= 0) return // hook's heartbeat fallback still drains
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = Math.round(width * dpr)
    cv.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const flights = createIntakeFlights(intake.visual)
    let raf = 0
    const square = (p: Pt, size: number, color: string, alpha = 1) => {
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size)
    }
    const frame = (now: number) => {
      const active = flights.tick(now)
      const g = geo.current
      ctx.clearRect(0, 0, width, height)
      const cols = Math.max(1, Math.floor((g.inbox.w - 24) / 8))
      const gridRows = Math.max(1, Math.ceil(g.total / cols))
      const pitchY = Math.min(7, (g.inbox.h - 65) / gridRows)
      const origin = (seq: number) => ({ x: g.inbox.x + 15 + (seq % cols) * 8, y: g.inbox.y + 49 + Math.floor(seq / cols) * pitchY })
      for (let i = g.decided; i < g.total; i++) square(origin(i), Math.min(4, pitchY - 1), "#a8adb5", 0.65)
      for (const [i, row] of g.rows.entries()) {
        const cols = Math.max(1, Math.ceil(row.events.length / 2))
        const pitch = Math.min(7, (g.rowWidth - 28) / cols)
        for (const [j, event] of row.events.entries()) {
          square({ x: g.rowLeft + 15 + (j % cols) * pitch, y: g.rowTop + i * 51 + 31 + Math.floor(j / cols) * 7 }, Math.max(1, pitch - 2), observed(event) ? HEAT : base.paletteOf(row.node.id).dot)
        }
      }
      for (const { event, start } of active) {
        const parent = base.parentOf(event.leaf_id)
        let i = g.rows.findIndex((r) => r.node.id === parent?.id)
        if (i < 0) i = g.rows.findIndex((r) => r.node.is_other)
        if (i < 0) continue // lifecycle still lands even with an unknown target
        const end = { x: g.rowLeft + 8, y: g.rowTop + i * 51 + 31 }
        const progress = Math.min(1, (now - start) / FLOW_FLIGHT_MS)
        const point = (k: number) => k < 0.22
          ? mix(origin(Math.max(0, event.seq - 1)), g.source, easeInOutCubic(k / 0.22))
          : k < 0.5 ? mix(g.source, g.jev, (k - 0.22) / 0.28)
            : compact
              ? along([g.jev, { x: g.jev.x, y: g.rowTop - 34 }, { x: 24, y: g.rowTop - 34 }, { x: 24, y: end.y }, end], easeInOutCubic((k - 0.5) / 0.5))
              : curve(g.jev, end, easeInOutCubic((k - 0.5) / 0.5))
        const color = progress < 0.5 ? "#969eaa" : observed(event) ? HEAT : base.paletteOf(event.leaf_id).dot
        for (let tail = 3; tail > 0; tail--) square(point(Math.max(0, progress - tail * 0.022)), 5, color, 0.14)
        square(point(progress), 6, color, 0.95)
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      flights.flush()
    }
  }, [base, intake.visual, width, height, compact])

  return (
    <section aria-label="Live intake flow" className="intake-flow relative inset-0 z-20 flex flex-col bg-card p-4 sm:p-5 lg:absolute lg:overflow-y-auto">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="mb-1 font-mono text-[10px] tracking-[0.14em] text-subtle uppercase">Live classification</p>
          <h2 className="text-[18px] font-semibold tracking-tight">From conversations to categories</h2>
        </div>
        <span className={cn("mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium", intake.published ? "bg-ok-soft text-ok" : "bg-brand-soft text-brand")}>
          {intake.published ? <Check className="size-3" /> : <Radio className="size-3" />}
          {intake.published ? "Published" : "Live"}
        </span>
      </header>
      <ol aria-label="Classification stages" className="my-4 grid grid-cols-2 gap-1.5 border-y py-3 sm:grid-cols-4">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px]", i === step ? "bg-brand text-white" : i < step ? "text-foreground" : "text-subtle")}>
            <span className={cn("grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px]", i === step ? "bg-white/20" : "bg-muted")}>
              {i < step ? <Check className="size-3" /> : `0${i + 1}`}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <p className="text-[12px] leading-relaxed text-muted-foreground">Pre-read on Vultr. Jev assigns each conversation to a frozen workflow and checks friction independently.</p>
      <div ref={boxRef} className="relative my-3 shrink-0" style={{ height }}>
        <svg aria-hidden width={width} height={height} className="pointer-events-none absolute inset-0">
          <path d={`M ${source.x} ${source.y} L ${jev.x} ${jev.y}`} fill="none" stroke="var(--border)" strokeWidth="1.5" />
          {rows.map((row, i) => {
            const y = rowTop + i * 51 + 31
            const mid = (jev.x + rowLeft) / 2
            const path = compact ? `M ${jev.x} ${jev.y} V ${rowTop - 34} H 24 V ${y} H ${rowLeft + 8}` : `M ${jev.x} ${jev.y} C ${mid} ${jev.y}, ${mid} ${y}, ${rowLeft + 8} ${y}`
            return <path key={row.node.id} d={path} fill="none" stroke={base.paletteOf(row.node.id).stroke} strokeLinejoin="round" strokeDasharray={row.node.is_other ? "4 4" : undefined} />
          })}
        </svg>
        <div className="absolute rounded-lg border bg-muted/25" style={{ left: inbox.x, top: inbox.y, width: inbox.w, height: inbox.h }}>
          <div className="flex items-center justify-between border-b px-3 py-2 text-[11px] font-medium">
            Incoming <span className="font-mono text-subtle">{fmtInt(total)}</span>
          </div>
          <p className="absolute right-0 bottom-2 left-0 text-center font-mono text-[11px] text-muted-foreground"><span className="text-foreground">{fmtInt(Math.max(0, total - decided))}</span> waiting</p>
        </div>
        <div className="absolute z-10 w-[88px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-brand/25 bg-card px-3 py-3 text-center shadow-xs" style={{ left: jev.x, top: jev.y }}>
          <span className="text-[20px] font-semibold tracking-tight text-brand">Jev</span>
          <p className="font-mono text-[9px] text-subtle">{intake.counters?.decisions_per_conversation ?? "—"} decisions</p>
        </div>
        {!compact ? <p className="absolute text-[10px] text-muted-foreground" style={{ left: jev.x - 34, top: jev.y + 55 }}>
          Confident theme<br />otherwise Other
        </p> : null}
        <p className="absolute font-mono text-[10px] text-subtle" style={{ left: rowLeft + 2, top: rowTop - 23 }}>{compact ? "Confident theme · otherwise Other" : "FROZEN CATEGORIES · new arrivals"}</p>
        <ol aria-label="Conversations filed by category">
          {rows.map((row, i) => (
            <li key={row.node.id} data-flow-row={row.node.id} data-count={row.events.length} className="absolute rounded-md border" style={{ left: rowLeft, top: rowTop + i * 51, width: rowWidth, height: 46, background: base.paletteOf(row.node.id).fill, borderColor: base.paletteOf(row.node.id).stroke }}>
              <div className="flex items-center justify-between gap-2 px-3 pt-1.5 text-[11.5px]">
                <span className="truncate">{row.node.is_other ? "Other or unclear" : row.node.short_title ?? row.node.title}</span>
                <span className="font-mono font-medium tabular-nums">+{row.events.length}</span>
              </div>
              <span className="sr-only">{row.events.filter(observed).length} with friction observed</span>
            </li>
          ))}
        </ol>
        <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0" style={{ width, height }} />
      </div>
      <footer className="mt-auto border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span><span data-testid="flow-filed" className="font-mono font-medium tabular-nums">{fmtInt(filed)} / {fmtInt(total)}</span><span className="text-muted-foreground"> filed</span></span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="size-1.5 bg-heat" aria-hidden />{friction} with friction observed</span>
        </div>
        <p role="status" className={cn("mt-2 flex items-center gap-1.5 text-[11px]", intake.published ? "text-ok" : "text-muted-foreground")}>
          <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
          {intake.published ? "Privacy gate passed. Returning to the updated map…" : step >= 3 ? "Privacy gate passed. Publishing the aggregate map…" : step === 2 ? "Checking the aggregate map at the privacy gate…" : "Each arriving tile is one Jev decision. Counts update when it lands."}
        </p>
      </footer>
    </section>
  )
}
