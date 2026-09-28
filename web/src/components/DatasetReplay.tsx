import { useEffect, useMemo, useRef, useState } from "react"
import { RotateCcw, ShieldCheck } from "lucide-react"
import { UltrasortButton } from "@/components/UltrasortButton"
import { useElementSize } from "@/hooks/useElementSize"
import { createMarbleScene, type MarbleBin, type MarbleScene } from "@/lib/marbleScene"
import { fmtInt } from "@/lib/format"
import type { SnapshotIndex } from "@/lib/snapshot"
import { GLM_BASELINE, glmEtaLabel, glmPaceLabel, glmRate } from "@/lib/ultrasort"
import { cn } from "@/lib/utils"

/** One marble per conversation in the map, up to this cap (the scene is tuned for far more). */
const MAX_MARBLES = 10_000
/** The last marble leaves the hopper by here; the rail and fall take ~2.5 s more, so a replay ends by ~10 s. */
const RELEASE_MS = 7000

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
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
/** FNV-1a of a category id: a fixed pseudo-random bin position that doesn't track size. */
const scatter = (id: string) => {
  let h = 2166136261
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

/** Largest-remainder split of `cap` marbles over `counts`, so the parts sum to exactly `cap`. */
function apportion(counts: number[], cap: number) {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= cap) return counts.slice()
  const raw = counts.map((c) => (c * cap) / total)
  const out = raw.map(Math.floor)
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (let k = 0, left = cap - out.reduce((a, b) => a + b, 0); k < left; k++) out[order[k][1]]++
  return out
}

/** Every marble's bin + friction flag in a shuffled order, with bursty release times squeezed into RELEASE_MS. */
function plan(bins: { marbles: number; friction: number }[]) {
  const drops: { bin: number; friction: boolean }[] = []
  bins.forEach((b, bin) => {
    for (let k = 0; k < b.marbles; k++) drops.push({ bin, friction: k < b.friction })
  })
  for (let k = drops.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1))
    ;[drops[k], drops[j]] = [drops[j], drops[k]]
  }
  const at: number[] = []
  let t = 0
  for (let k = 0; k < drops.length; k++) {
    t += Math.random() < 0.18 ? 0.1 + Math.random() * 0.3 : -Math.log(1 - Math.random())
    at.push(t)
  }
  const k = t > 0 ? RELEASE_MS / t : 0
  return drops.map((d, i) => ({ ...d, at: at[i] * k }))
}

type Phase = "armed" | "running" | "done"

/**
 * The Dataset tab's marble machine: a replay of how Jev sorted the published map, one marble per
 * conversation, each bin ending on its category's bubble count. Nothing is sent and nothing is published.
 * Key it on the snapshot id: a new snapshot means a new machine.
 */
export function DatasetReplay({ index, active }: { index: SnapshotIndex; active: boolean }) {
  const [webgl] = useState(hasWebGL)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<MarbleScene | null>(null)
  const startRef = useRef<(() => void) | null>(null)
  const { width, height } = useElementSize(boxRef)
  const [run, setRun] = useState(0)
  const [phase, setPhase] = useState<Phase>("armed")
  const [sorted, setSorted] = useState({ landed: 0, friction: 0 })

  // bins in a stable scattered order (Other last) so the piles don't read as a size staircase
  const bins = useMemo(() => {
    const cats = [...index.categories].sort((a, b) => Number(!!a.is_other) - Number(!!b.is_other) || scatter(a.id) - scatter(b.id))
    const total = cats.reduce((a, c) => a + c.conversations, 0)
    const marbles = apportion(
      cats.map((c) => c.conversations),
      MAX_MARBLES,
    )
    const capacity = marbles.reduce((a, b) => a + b, 0)
    const spec: MarbleBin[] = cats.map((c) => ({ label: c.is_other ? "Other or unclear" : c.short_title || c.title, hue: c.is_other ? null : hueOf(index.paletteOf(c.id).dot), weight: c.conversations }))
    const perBin = cats.map((c, i) => ({ marbles: marbles[i], friction: c.conversations ? Math.round((marbles[i] * c.friction.conversations) / c.conversations) : 0 }))
    return { cats, spec, perBin, total, capacity, friction: cats.reduce((a, c) => a + c.friction.conversations, 0) }
  }, [index])
  const scale = bins.capacity ? bins.total / bins.capacity : 1

  const again = () => {
    setPhase("armed")
    setSorted({ landed: 0, friction: 0 })
    setRun((r) => r + 1)
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !webgl || !bins.capacity) return
    const still = reducedMotion()
    const scene = createMarbleScene(canvas, {
      capacity: bins.capacity,
      countScale: scale,
      bins: bins.spec,
      armed: true,
      reducedMotion: still,
      dripCapacity: 3000,
      dripHold: GLM_BASELINE.secondsPerCall,
    })
    sceneRef.current = scene
    const drops = plan(bins.perBin)
    // While armed the replay's own marbles drip through at GLM's estimated pace (glmRate() conversations/s)
    // and count as they land; Ultrasort pours the rest of the same plan, so every bin still ends on its bubble.
    const dripPerSecond = glmRate() / scale
    const armedAt = performance.now()
    let dripped = 0
    let t0: number | null = null
    let next = 0
    let offset = 0
    let lastStats = 0
    startRef.current = () => {
      if (t0 !== null) return
      t0 = performance.now()
      offset = drops[next]?.at ?? 0 // the rest of the plan starts now, not where its clock was
      scene.ultrasort()
      setPhase("running")
    }
    let raf = 0
    const frame = () => {
      if (t0 === null) {
        const due = Math.floor(((performance.now() - armedAt) / 1000) * dripPerSecond) + 1
        // after a paused (hidden) tab, resume the pace instead of dumping the backlog
        dripped = Math.max(dripped, due - 4)
        for (; dripped < due && next < drops.length; dripped++) {
          if (!scene.drip(drops[next].bin, { friction: drops[next].friction })) break
          next++
        }
      } else {
        const now = performance.now()
        const elapsed = still ? Infinity : now - t0 + offset
        for (; next < drops.length && drops[next].at <= elapsed; next++) scene.push(drops[next].bin, drops[next].friction)
        if (now - lastStats > 100) {
          lastStats = now
          const s = scene.stats()
          setSorted({ landed: s.landed, friction: s.bins.reduce((a, b) => a + b.friction, 0) })
          if (next >= drops.length && s.drained) {
            setPhase("done")
            return // the scene keeps rendering its own frames
          }
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      startRef.current = null
      scene.dispose()
      sceneRef.current = null
    }
  }, [webgl, bins, scale, run])

  useEffect(() => {
    if (width > 0 && height > 0) sceneRef.current?.resize(width, height, { top: 0.03, bottom: 0.03 })
  }, [width, height, bins, run])

  // Space starts the replay (or runs it again once done); ignored while typing or on another tab.
  useEffect(() => {
    if (!active || phase === "running") return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return
      if (e.code === "Space" || e.key === "Enter") {
        e.preventDefault()
        if (phase === "armed") startRef.current?.()
        else again()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const landed = Math.min(bins.total, Math.round(sorted.landed * scale))
  const friction = Math.min(bins.friction, Math.round(sorted.friction * scale))
  const exact = bins.capacity === bins.total

  return (
    <section aria-label="Dataset replay" className="intake-flow absolute inset-0 z-20 flex flex-col overflow-hidden bg-card">
      <div ref={boxRef} className="relative min-h-0 flex-1">
        {webgl ? (
          <canvas ref={canvasRef} aria-hidden className="absolute inset-0 touch-none" style={{ width, height }} />
        ) : (
          <p className="absolute inset-x-0 bottom-6 text-center text-[12.5px] text-muted-foreground">This browser has no WebGL, so the machine can't draw. The map below has the same counts.</p>
        )}
        {/* HUD: the canvas under it takes zoom and pan, so only controls catch the pointer */}
        <div className="pointer-events-none absolute top-4 right-5 flex max-w-[min(760px,62%)] flex-col gap-4">
          <header>
            <p className="mb-1 font-mono text-[10px] tracking-[0.14em] text-subtle uppercase">Replay · how Jev sorted this dataset</p>
            <h2 className="text-[22px] font-semibold tracking-tight">
              {fmtInt(bins.total)} conversations → {bins.cats.length} workflows
            </h2>
          </header>
          {phase === "armed" ? (
            <div className="flex flex-wrap items-center gap-4">
              <UltrasortButton onPress={() => startRef.current?.()} pressed={phase !== "armed"} reducedMotion={reducedMotion()} />
              <p className="max-w-[380px] text-[12px] leading-snug text-muted-foreground">
                <span data-testid="glm-estimate" className="block font-medium text-foreground">
                  {glmPaceLabel()} · {glmEtaLabel(bins.total)}
                </span>
                Until you press, the map's conversations trickle in at GLM's estimated pace. Ultrasort pours in the rest; each bin ends on the count in its bubble below.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
                <Stat label="Sorted" value={`${fmtInt(landed)} / ${fmtInt(bins.total)}`} testId="replay-sorted" />
                <Stat label="With friction" value={fmtInt(friction)} />
              </dl>
              {phase === "done" ? (
                <button
                  type="button"
                  onClick={again}
                  className="pointer-events-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  <RotateCcw className="size-3.5" />
                  Replay
                </button>
              ) : null}
            </div>
          )}
        </div>

        {/* the scene draws the bins; this list carries the same final counts for screen readers and tests */}
        <ol aria-label="Conversations by workflow" className="sr-only">
          {bins.cats.map((c) => (
            <li key={c.id} data-replay-row={c.id} data-count={c.conversations}>
              {c.is_other ? "Other or unclear" : c.short_title ?? c.title}: {fmtInt(c.conversations)} conversations, {fmtInt(c.friction.conversations)} with friction
            </li>
          ))}
        </ol>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2 text-[11.5px] text-muted-foreground">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>{exact ? "One marble per conversation in the map" : `${fmtInt(bins.capacity)} marbles for ${fmtInt(bins.total)} conversations`}, coloured by its workflow</span>
          {webgl ? <span className="text-subtle">Scroll to zoom · drag to orbit · double-click to reset</span> : null}
        </span>
        <span className={cn("flex items-center gap-1.5", phase === "done" && "text-ok")}>
          <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
          A replay of the published map: nothing is sent and nothing changes.
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
