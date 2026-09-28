import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, Radio, ShieldCheck } from "lucide-react"
import type { useIntake } from "@/hooks/useIntake"
import { UltrasortButton } from "@/components/UltrasortButton"
import { useElementSize } from "@/hooks/useElementSize"
import { flowRows, flowStep } from "@/lib/intakeFlow"
import { observedSignals } from "@/lib/intake"
import { createMarbleScene, type MarbleBin, type MarbleScene } from "@/lib/marbleScene"
import { fmtInt } from "@/lib/format"
import { signalName } from "@/lib/colors"
import type { SnapshotIndex } from "@/lib/snapshot"
import type { IntakeEvent, Signal } from "@/lib/types"
import { GLM_BASELINE, binSampler, glmEtaLabel, glmPaceLabel, glmRate, resultLine } from "@/lib/ultrasort"
import { cn } from "@/lib/utils"

type Intake = ReturnType<typeof useIntake>

/** Marbles drawn per run, whatever the real batch size; counts shown stay real. */
const VISUAL_MARBLES = 300
const STEPS = ["Read by GLM (earlier)", "Jev sorts", "Privacy gate", "Publish"]
const observed = (event: IntakeEvent) => Object.values(event.friction).includes("observed")
const hueOf = (color: string) => {
  const m = /oklch\([^)]*\s([\d.]+)\)/.exec(color)
  return m ? Number(m[1]) : 250
}
const hasWebGL = () => {
  try {
    return !!document.createElement("canvas").getContext("webgl2")
  } catch {
    return false
  }
}

/** The run is drawn as VISUAL_MARBLES marbles spread over the real batch; each conversation's share drops the moment Jev's answer for it lands. */
export function MarbleMachine({ intake, index, armed, onSort, action }: { intake: Intake; index: SnapshotIndex; armed: boolean; onSort: () => void; action?: React.ReactNode }) {
  const [base] = useState(index)
  const [webgl] = useState(hasWebGL)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<MarbleScene | null>(null)
  const { width, height } = useElementSize(boxRef)
  const rows = useMemo(() => flowRows(base, intake.landedEvents), [base, intake.landedEvents])
  const total = intake.counters?.total ?? intake.status?.batch_size ?? 0
  const filed = intake.landedEvents.length
  const step = armed ? 1 : flowStep(intake.stage, intake.published)
  const running = !armed && !intake.published
  // bins follow flowRows' order (Other last); fixed for the machine's lifetime
  const bins = useMemo(() => {
    const cats = flowRows(base, []).map((row) => row.node)
    const spec: MarbleBin[] = cats.map((c) => ({ label: c.is_other ? "Other or unclear" : c.short_title || c.title, hue: c.is_other ? null : hueOf(base.paletteOf(c.id).dot), weight: c.conversations }))
    return { ids: cats.map((c) => c.id), spec }
  }, [base])

  const live = useRef({ armed, filed: intake.landedEvents, visual: intake.visual })
  useEffect(() => {
    live.current = { armed, filed: intake.landedEvents, visual: intake.visual }
  })

  // Race clock: from the press to the moment the last real event lands. Jev's time is only ever this measurement.
  const [race, setRace] = useState<{ start: number; end: number | null; n: number } | null>(null)
  const [clock, setClock] = useState(0)
  const landed = useRef({ n: 0, at: 0 })
  const sort = useCallback(() => {
    sceneRef.current?.ultrasort()
    setRace((r) => r ?? { start: performance.now(), end: null, n: 0 })
    onSort()
  }, [onSort])
  // a start from elsewhere (the toolbar) still clears the GLM drip and starts the clock
  const wasArmed = useRef(armed)
  useEffect(() => {
    if (wasArmed.current && !armed) {
      sceneRef.current?.ultrasort()
      setRace((r) => r ?? { start: performance.now(), end: null, n: 0 })
    }
    wasArmed.current = armed
  }, [armed])
  useEffect(() => {
    if (!race || race.end !== null) return
    if (filed > landed.current.n) landed.current = { n: filed, at: performance.now() }
    const done = (total > 0 && filed >= total) || intake.published || intake.phase === "failed"
    if (done) setRace({ ...race, end: filed ? landed.current.at : performance.now(), n: filed })
  }, [race, filed, total, intake.published, intake.phase])
  useEffect(() => {
    if (!race || race.end !== null) return
    const id = window.setInterval(() => setClock(performance.now()), 100)
    return () => window.clearInterval(id)
  }, [race])
  const raceSeconds = race ? Math.max(0, ((race.end ?? clock) - race.start) / 1000) : 0

  // Space sorts (the "snap"); ignored while typing.
  useEffect(() => {
    if (!armed) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.code === "Space" || e.key === "Enter") {
        e.preventDefault()
        sort()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [armed, sort])

  // The scene animates each marble from the moment it is pushed, so events are
  // filed with the hook as soon as the scheduler releases them and the marble
  // carries the rest of the story on the GPU.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !webgl) return
    const marbles = total > 0 ? VISUAL_MARBLES : 1
    const scene = createMarbleScene(canvas, {
      capacity: marbles,
      countScale: total / marbles,
      bins: bins.spec,
      armed: live.current.armed,
      reducedMotion: live.current.visual.reducedMotion,
      dripCapacity: 3000,
      dripHold: GLM_BASELINE.secondsPerCall,
    })
    sceneRef.current = scene
    // GLM drip while armed: glmRate() conversations/s, in marbles of the same size as the real ones
    const dripPerSecond = total > 0 ? (glmRate() * marbles) / total : 0
    const sampleBin = binSampler(bins.spec.map((b) => b.weight))
    let dripStart = -1
    let dripped = 0
    const other = Math.max(0, bins.ids.findIndex((id) => base.byId.get(id)?.is_other))
    const binOf = (event: IntakeEvent) => {
      const i = bins.ids.indexOf(base.parentOf(event.leaf_id)?.id ?? "")
      return i < 0 ? other : i
    }
    const pushed = new Set<number>()
    let released = 0
    const drop = (event: IntakeEvent) => {
      if (pushed.has(event.seq)) return
      pushed.add(event.seq)
      // this conversation's share of the marbles, rounded cumulatively so the run ends exactly on `marbles`
      const upTo = Math.round((pushed.size * marbles) / Math.max(1, total))
      const bin = binOf(event)
      const friction = observed(event)
      for (; released < upTo; released++) scene.push(bin, friction)
    }
    for (const event of live.current.filed) drop(event)
    let raf = 0
    const frame = () => {
      const { armed, filed, visual } = live.current
      if (armed && dripPerSecond > 0) {
        const t = performance.now()
        if (dripStart < 0) dripStart = t
        const due = Math.floor(((t - dripStart) / 1000) * dripPerSecond) + 1
        // after a paused (hidden) tab, resume the pace instead of dumping the backlog
        dripped = Math.max(dripped, due - 4)
        for (; dripped < due; dripped++) scene.drip(sampleBin())
      }
      if (!armed) {
        scene.open()
        visual.heartbeat()
        const tick = visual.scheduler.tick(performance.now())
        for (const event of tick.spawn) {
          visual.onSpawn(event)
          visual.onLand(event)
          visual.scheduler.land()
          drop(event)
        }
        for (const event of tick.instant) {
          visual.onSpawn(event)
          visual.onLand(event)
          drop(event)
        }
        // the hook files events itself while frames are paused (hidden tab); catch the marbles up
        if (filed.length > pushed.size) for (const event of filed) drop(event)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      scene.dispose()
      sceneRef.current = null
    }
  }, [webgl, total, bins, base])

  useEffect(() => {
    if (width > 0 && height > 0) sceneRef.current?.resize(width, height, { top: 0.03, bottom: 0.03 })
  }, [width, height, total, bins])

  const jevDecisions = filed * (intake.counters?.decisions_per_conversation ?? 5)

  return (
    <section aria-label="Live intake sorting machine" className="intake-flow absolute inset-0 z-20 flex flex-col overflow-hidden bg-card">
      <div ref={boxRef} className="relative min-h-0 flex-1">
        {webgl ? (
          <canvas ref={canvasRef} aria-hidden className="absolute inset-0 touch-none" style={{ width, height }} />
        ) : (
          <p className="absolute inset-x-0 bottom-6 text-center text-[12.5px] text-muted-foreground">This browser has no WebGL, so the machine can't draw. The counts below still update live.</p>
        )}
        {/* HUD: the canvas under it takes zoom and pan, so only controls catch the pointer */}
        <div className="pointer-events-none absolute top-4 right-5 flex max-w-[min(760px,62%)] flex-col gap-4">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="mb-1 font-mono text-[10px] tracking-[0.14em] text-subtle uppercase">Live classification · TypeSafe Jev</p>
              <h2 className="text-[22px] font-semibold tracking-tight">
                {fmtInt(total)} conversations → {rows.length} workflows
              </h2>
            </div>
            <div className="pointer-events-auto flex shrink-0 items-center gap-2">
              {action}
              <span className={cn("mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium", intake.published ? "bg-ok-soft text-ok" : armed ? "bg-muted text-muted-foreground" : "bg-brand-soft text-brand")}>
                {intake.published ? <Check className="size-3.5" /> : <Radio className={cn("size-3.5", running && "animate-pulse")} />}
                {intake.published ? "Published" : armed ? "Ready" : "Live"}
              </span>
            </div>
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
              <UltrasortButton onPress={sort} pressed={!armed} reducedMotion={intake.visual.reducedMotion} />
              <p className="max-w-[380px] text-[12px] leading-snug text-muted-foreground">
                <span data-testid="glm-estimate" className="block font-medium text-foreground">
                  {glmPaceLabel()}
                  {total > 0 ? ` · ${glmEtaLabel(total)}` : null}
                </span>
                The drip is GLM's estimated pace and is never counted. Ultrasort hands the batch to Jev: {intake.counters?.decisions_per_conversation ?? 5} decisions per conversation, each marble dropping the moment its real answer lands.
                <span className="mt-1 block text-subtle">Esc to cancel</span>
              </p>
            </div>
          ) : (
            <div className="flex max-w-[720px] flex-col gap-2">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                <Stat label="Sorted" value={`${fmtInt(filed)} / ${fmtInt(total)}`} testId="flow-filed" />
                <Stat label="Jev decisions" value={fmtInt(jevDecisions)} />
                <Stat label="Conversations / s" value={intake.counters?.per_second ? intake.counters.per_second.toFixed(0) : "—"} />
                <Stat label="Median Jev call" value={intake.counters?.p50_ms ? `${fmtInt(intake.counters.p50_ms)} ms` : "—"} />
              </dl>
              {race ? (
                <p data-testid="ultrasort-clock" data-seconds={race.end === null ? undefined : raceSeconds.toFixed(3)} className="font-mono text-[13px] font-medium tabular-nums">
                  {race.end === null
                    ? `Jev ${raceSeconds.toFixed(1)} s · ${glmEtaLabel(total)}`
                    : race.n > 0 && intake.phase !== "failed"
                      ? resultLine(race.n, raceSeconds)
                      : "The run stopped before Jev sorted the batch."}
                </p>
              ) : null}
            </div>
          )}
          {!armed ? (
            <div aria-live="off" className="max-w-[720px]">
              <p className="mb-1 font-mono text-[10px] tracking-[0.12em] text-subtle uppercase">Jev just decided · sampled</p>
              {intake.feed.length ? (
                <ul className="flex flex-col gap-0.5">
                  {intake.feed.slice(0, 3).map((ev, i) => {
                    const node = base.byId.get(ev.leaf_id)
                    const signals = observedSignals(ev)
                    return (
                      <li key={ev.seq} className={cn("flex items-center gap-2 truncate text-[12.5px] transition-opacity", i === 0 ? "opacity-100" : i === 1 ? "opacity-60" : "opacity-35")}>
                        {/* same colour as the marble: the workflow, not friction */}
                        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: base.paletteOf(ev.leaf_id).dot }} />
                        <span className="font-medium">{node?.short_title ?? node?.title ?? "Other or unclear"}</span>
                        <span className="text-muted-foreground tabular-nums">{Math.round(ev.p * 100)}% sure</span>
                        {signals.length ? <span className="text-heat">friction: {signals.map((s) => signalName(s as Signal).toLowerCase()).join(", ")}</span> : <span className="text-muted-foreground">no friction</span>}
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

        {/* the scene draws the bins; this list carries the same counts for screen readers and tests */}
        <ol aria-label="Conversations filed by workflow" className="sr-only">
          {rows.map((row) => {
            const rowFriction = row.events.filter(observed).length
            return (
              <li key={row.node.id} data-flow-row={row.node.id} data-count={row.events.length}>
                {row.node.is_other ? "Other or unclear" : row.node.short_title ?? row.node.title}: +{row.events.length}, {fmtInt(row.node.conversations)} → {fmtInt(row.node.conversations + row.events.length)}, {rowFriction} with friction
              </li>
            )
          })}
        </ol>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2 text-[11.5px] text-muted-foreground">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>{fmtInt(VISUAL_MARBLES)} marbles drawn for {fmtInt(total)} conversations, coloured by the workflow Jev chose</span>
          {webgl ? <span className="text-subtle">Scroll to zoom · drag to orbit · double-click to reset</span> : null}
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
