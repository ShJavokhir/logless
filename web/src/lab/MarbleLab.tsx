import { useEffect, useRef, useState } from "react"
import { createMarbleScene, type MarbleBin, type MarbleScene, type MarbleStats } from "@/lib/marbleScene"
import { indexSnapshot } from "@/lib/snapshot"
import type { Snapshot } from "@/lib/types"
import snapshot from "@/mocks/real-snapshot.json"

// Dev bench for the WebGL sorter: a synthetic 100k-in-10s stream shaped like
// the real snapshot, pushed in ~100 ms bursts the way polling delivers them.
const index = indexSnapshot(snapshot as unknown as Snapshot)
const cats = [...index.categories].sort((a, b) => Number(!!a.is_other) - Number(!!b.is_other))
const hueOf = (color: string) => {
  const m = /oklch\([^)]*\s([\d.]+)\)/.exec(color)
  return m ? Number(m[1]) : 250
}
const BINS: MarbleBin[] = cats.map((c) => ({ label: c.short_title || c.title, hue: c.is_other ? null : hueOf(index.paletteOf(c.id).dot), weight: c.conversations }))

export default function MarbleLab() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const total = Number(params.get("n")) || 100_000
  const seconds = Number(params.get("s")) || 10
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<MarbleScene | null>(null)
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
      scene.dispose()
      sceneRef.current = null
    }
  }, [total, run])

  const start = () => {
    const scene = sceneRef.current
    if (!scene) return
    scene.open()
    const weights = BINS.map((b) => b.weight)
    const sum = weights.reduce((a, b) => a + b, 0)
    const cdf = weights.map(((acc) => (w: number) => (acc += w / sum))(0))
    let sent = 0
    const t0 = performance.now()
    const timer = window.setInterval(() => {
      const due = Math.min(total, Math.round((total * (performance.now() - t0)) / (seconds * 1000)))
      for (; sent < due; sent++) {
        const u = Math.random()
        const bin = cdf.findIndex((c) => u <= c)
        scene.push(bin < 0 ? BINS.length - 1 : bin, Math.random() < 0.2)
      }
      if (sent >= total) window.clearInterval(timer)
    }, 100)
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
