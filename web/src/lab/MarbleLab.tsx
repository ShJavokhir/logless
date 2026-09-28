import { useCallback, useEffect, useRef, useState } from "react"
import { RotateCcw } from "lucide-react"
import { UltrasortButton } from "@/components/UltrasortButton"
import { createMarbleScene, type MarbleBin, type MarbleScene, type MarbleStats } from "@/lib/marbleScene"
import { fmtInt } from "@/lib/format"
import { indexSnapshot } from "@/lib/snapshot"
import { GLM_BASELINE, glmEtaLabel, glmPaceLabel, glmRate, resultLine } from "@/lib/ultrasort"
import type { Snapshot } from "@/lib/types"
import snapshot from "@/mocks/real-snapshot.json"

// Dev bench for the WebGL sorter: a synthetic 100k-in-10s stream shaped like
// the real snapshot, pushed in ~100 ms bursts the way polling delivers them.
// #/marble-lab?mode=ultrasort runs the before/after demo: a simulated GLM drip,
// then the Ultrasort flood with a race clock measured from real timestamps.
const index = indexSnapshot(snapshot as unknown as Snapshot)
const cats = [...index.categories].sort((a, b) => Number(!!a.is_other) - Number(!!b.is_other))
const hueOf = (color: string) => {
  const m = /oklch\([^)]*\s([\d.]+)\)/.exec(color)
  return m ? Number(m[1]) : 250
}
const BINS: MarbleBin[] = cats.map((c) => ({ label: c.short_title || c.title, hue: c.is_other ? null : hueOf(index.paletteOf(c.id).dot), weight: c.conversations }))
const WEIGHT_SUM = BINS.reduce((a, b) => a + b.weight, 0)
const CDF = BINS.map(((acc) => (b: MarbleBin) => (acc += b.weight / WEIGHT_SUM))(0))
/** a bin drawn from the base snapshot's distribution */
const sampleBin = () => {
  const u = Math.random()
  const bin = CDF.findIndex((c) => u <= c)
  return bin < 0 ? BINS.length - 1 : bin
}

const DRIP_CAPACITY = 3000
const INSET = { top: 0.03, bottom: 0.03 }

/** Push `total` synthetic decisions over `seconds`; `onFiled` gets the timestamp of the last push. Returns a stop function. */
function pushStream(scene: MarbleScene, total: number, seconds: number, onFiled?: (at: number) => void) {
  let sent = 0
  const t0 = performance.now()
  const timer = window.setInterval(() => {
    const now = performance.now()
    const due = Math.min(total, Math.round((total * (now - t0)) / (seconds * 1000)))
    for (; sent < due; sent++) scene.push(sampleBin(), Math.random() < 0.2)
    if (sent >= total) {
      window.clearInterval(timer)
      onFiled?.(now)
    }
  }, 100)
  return () => window.clearInterval(timer)
}

export default function MarbleLab() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const total = Number(params.get("n")) || 5_000
  const seconds = Number(params.get("s")) || 5
  return params.get("mode") === "ultrasort" ? <UltrasortLab total={total} seconds={seconds} /> : <DefaultLab total={total} seconds={seconds} />
}

function DefaultLab({ total, seconds }: { total: number; seconds: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<MarbleScene | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const [run, setRun] = useState(0)
  const [stats, setStats] = useState<MarbleStats | null>(null)
  const [fps, setFps] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current!
    const scene = createMarbleScene(canvas, { capacity: total, bins: BINS, armed: true })
    sceneRef.current = scene
    const fit = () => scene.resize(canvas.clientWidth, canvas.clientHeight)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(canvas)
    let frames = 0
    let last = performance.now()
    let raf = 0
    const count = () => {
      frames++
      const now = performance.now()
      if (now - last > 500) {
        setFps(Math.round((frames * 1000) / (now - last)))
        setStats(scene.stats())
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(count)
    }
    raf = requestAnimationFrame(count)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      stopRef.current?.()
      stopRef.current = null
      scene.dispose()
      sceneRef.current = null
    }
  }, [total, run])

  const start = () => {
    const scene = sceneRef.current
    if (!scene) return
    scene.open()
    stopRef.current?.()
    stopRef.current = pushStream(scene, total, seconds)
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex items-center gap-4 px-4 py-2 font-mono text-sm">
        <button className="rounded-md bg-foreground px-3 py-1 text-background" onClick={start}>Run {total.toLocaleString()} in {seconds}s</button>
        <button className="rounded-md border px-3 py-1" onClick={() => setRun((r) => r + 1)}>Reset</button>
        <span data-testid="lab-fps">{fps} fps</span>
        {stats && <span>spawned {stats.spawned.toLocaleString()} · landed {stats.landed.toLocaleString()}</span>}
      </div>
      <canvas ref={canvasRef} className="min-h-0 w-full flex-1" />
    </div>
  )
}

type Hud = { landed: number; dripSorted: number; clock: number | null; frozen: boolean }

function UltrasortLab({ total, seconds }: { total: number; seconds: number }) {
  const [reducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<MarbleScene | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  // timestamps (performance.now ms) of the run; the race clock reads only these
  const pressAtRef = useRef<number | null>(null)
  const filedAtRef = useRef<number | null>(null)
  const [run, setRun] = useState(0)
  const [pressed, setPressed] = useState(false)
  const [fps, setFps] = useState(0)
  const [hud, setHud] = useState<Hud>({ landed: 0, dripSorted: 0, clock: null, frozen: false })

  useEffect(() => {
    const canvas = canvasRef.current!
    const scene = createMarbleScene(canvas, { capacity: total, bins: BINS, armed: true, reducedMotion, dripCapacity: DRIP_CAPACITY, dripHold: GLM_BASELINE.secondsPerCall })
    sceneRef.current = scene
    pressAtRef.current = null
    filedAtRef.current = null
    const fit = () => scene.resize(canvas.clientWidth, canvas.clientHeight, INSET)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(canvas)

    const rate = glmRate()
    const inFlight = Math.round(rate * GLM_BASELINE.secondsPerCall)
    let dripDue = 0
    let dripIssued = 0
    let frames = 0
    let prev = performance.now()
    let lastFps = prev
    let lastHud = 0
    let raf = 0
    const tick = () => {
      const now = performance.now()
      // the drip's pace comes from elapsed time; a paused tab doesn't burst on return
      const dt = Math.min(0.25, (now - prev) / 1000)
      prev = now
      if (pressAtRef.current === null) {
        dripDue += dt * rate
        while (dripDue >= 1) {
          dripDue -= 1
          dripIssued++
          scene.drip(sampleBin())
        }
      }
      frames++
      if (now - lastFps > 500) {
        setFps(Math.round((frames * 1000) / (now - lastFps)))
        frames = 0
        lastFps = now
      }
      if (now - lastHud >= 100) {
        lastHud = now
        const pressAt = pressAtRef.current
        const filedAt = filedAtRef.current
        setHud({
          landed: scene.stats().landed,
          // a simulated call counts as sorted once its secondsPerCall has elapsed
          dripSorted: Math.max(0, dripIssued - inFlight),
          clock: pressAt === null ? null : ((filedAt ?? now) - pressAt) / 1000,
          frozen: filedAt !== null,
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      stopRef.current?.()
      stopRef.current = null
      scene.dispose()
      sceneRef.current = null
    }
  }, [total, run, reducedMotion])

  const ultrasort = useCallback(() => {
    const scene = sceneRef.current
    if (!scene || pressAtRef.current !== null) return
    setPressed(true)
    // ultrasort() opens the gate, so the stream pushes without calling open()
    scene.ultrasort()
    pressAtRef.current = performance.now()
    stopRef.current = pushStream(scene, total, seconds, (at) => {
      filedAtRef.current = at
    })
  }, [total, seconds])

  const reset = () => {
    setPressed(false)
    setHud({ landed: 0, dripSorted: 0, clock: null, frozen: false })
    setRun((r) => r + 1)
  }

  // Space (or Enter) triggers Ultrasort; ignored while typing.
  useEffect(() => {
    if (pressed) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.code === "Space" || e.key === "Enter") {
        e.preventDefault()
        ultrasort()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [pressed, ultrasort])

  const done = pressed && hud.frozen && hud.clock !== null && hud.landed >= total

  return (
    <div className="relative h-screen overflow-hidden bg-card">
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full touch-none" />
      <div className="pointer-events-none absolute top-3 left-4 flex items-center gap-3 font-mono text-[11px] text-subtle">
        <span data-testid="lab-fps">{fps} fps</span>
        <button type="button" onClick={reset} className="pointer-events-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <RotateCcw className="size-3" />
          Reset
        </button>
      </div>
      <div className="pointer-events-none absolute top-4 right-5 flex max-w-[min(760px,62%)] flex-col gap-4">
        <div>
          <p className="mb-1 font-mono text-[10px] tracking-[0.14em] text-subtle uppercase">{pressed ? "Marble lab · synthetic stream" : "Marble lab · simulated GLM drip"}</p>
          <h2 className="text-[22px] font-semibold tracking-tight">
            {fmtInt(total)} conversations → {BINS.length} workflows
          </h2>
        </div>
        {pressed ? (
          <>
            <dl className="grid max-w-[480px] grid-cols-2 gap-x-6 gap-y-2">
              <Stat label="Sorted" value={`${fmtInt(hud.landed)} / ${fmtInt(total)}`} />
              <Stat label="Race clock" value={`${(hud.clock ?? 0).toFixed(1)} s`} testId="race-clock" />
            </dl>
            {done ? (
              <p data-testid="result-line" className="text-[13px] font-medium">
                {resultLine(total, hud.clock ?? 0)}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="text-[12.5px] leading-snug">
              <p className="text-muted-foreground">
                {glmPaceLabel()} <span className="text-subtle">· simulated drip</span>
              </p>
              <p className="text-muted-foreground">est. {glmEtaLabel(total)}</p>
              <p className="mt-1 font-mono text-[11px] text-subtle tabular-nums">{fmtInt(hud.dripSorted)} sorted by the simulated drip</p>
            </div>
          </>
        )}
        {/* stays up after the press so its flood to solid violet reads as the trigger */}
        <div className="pointer-events-auto self-start">
          <UltrasortButton onPress={ultrasort} pressed={pressed} reducedMotion={reducedMotion} />
        </div>
      </div>
    </div>
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
