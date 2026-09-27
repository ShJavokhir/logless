import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, describeError } from "@/lib/api"
import { createIntakeScheduler, type IntakeScheduler } from "@/lib/intake"
import { FLOW_HOLD_MS } from "@/lib/intakeFlow"
import { presenterKey } from "@/lib/presenter"
import type { IntakeCounters, IntakeEvent, IntakeEventsResponse, IntakeStage, IntakeStatus, IntakeSummary, Snapshot } from "@/lib/types"

export const INTAKE_POLL_MS = 300
const FEED_KEEP = 12
/** At ~45 decisions/s every line would be gone before it's read: sample one per interval. */
export const FEED_SAMPLE_MS = 420

export type IntakePhase = "idle" | "starting" | "running" | "done" | "failed"

/** What the flow view needs to animate the stream. */
export type IntakeVisual = {
  scheduler: IntakeScheduler<IntakeEvent>
  reducedMotion: boolean
  /** a tile left the inbox (Jev decided) */
  onSpawn: (ev: IntakeEvent) => void
  /** a tile reached its category (filed) */
  onLand: (ev: IntakeEvent) => void
  /** the view calls this every frame; without it the hook files events itself */
  heartbeat: () => void
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

/**
 * Presenter-only live intake (§11): starts a run, polls its events every
 * ~300 ms, paces them into animations, and swaps in the published snapshot
 * once every event has landed (so nothing is counted twice).
 */
export function useIntake(snapshot: Snapshot | null, onPublished: (s: Snapshot) => void) {
  const presenter = !!presenterKey()
  const [status, setStatus] = useState<IntakeStatus | null>(null)
  const [phase, setPhase] = useState<IntakePhase>("idle")
  const [runId, setRunId] = useState<string | null>(null)
  const [stage, setStage] = useState<IntakeStage | null>(null)
  const [runState, setRunState] = useState<IntakeEventsResponse["state"] | null>(null)
  const [counters, setCounters] = useState<IntakeCounters | null>(null)
  const [feed, setFeed] = useState<IntakeEvent[]>([])
  const [liveDelta, setLiveDelta] = useState<Map<string, number>>(new Map())
  const [summary, setSummary] = useState<IntakeSummary | null>(null)
  const [published, setPublished] = useState(false)
  const [landedEvents, setLandedEvents] = useState<IntakeEvent[]>([])
  const [flowDismissed, setFlowDismissed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [reducedMotion] = useState(prefersReducedMotion)
  const [scheduler] = useState(() => createIntakeScheduler<IntakeEvent>({ reducedMotion: prefersReducedMotion() }))
  const feedRef = useRef<IntakeEvent[]>([])
  const latestRef = useRef<IntakeEvent | null>(null)
  const lastFeedAtRef = useRef(0)
  const deltaRef = useRef(new Map<string, number>())
  const landedRef = useRef(new Map<number, IntakeEvent>())
  const expectedRef = useRef(0)
  const generationRef = useRef(0)
  const dirtyRef = useRef(false)
  const beatRef = useRef(0)
  const lastSeqRef = useRef(0)
  const publishRef = useRef<"no" | "waiting" | "done">("no")
  const baseIdRef = useRef<string | null>(null)
  const onPublishedRef = useRef(onPublished)
  useEffect(() => {
    onPublishedRef.current = onPublished
  }, [onPublished])

  const refreshStatus = useCallback(async () => {
    if (!presenterKey()) return
    try {
      setStatus(await api.getIntakeStatus())
    } catch {
      setStatus(null)
    }
  }, [])

  // Presenters only: the public never triggers the status call.
  useEffect(() => {
    if (!presenter) return
    let alive = true
    api.getIntakeStatus().then(
      (s) => alive && setStatus(s),
      () => alive && setStatus(null),
    )
    return () => {
      alive = false
    }
  }, [presenter])

  const visual: IntakeVisual = useMemo(
    () => ({
      scheduler,
      reducedMotion,
      onSpawn: (ev) => {
        latestRef.current = ev
      },
      onLand: (ev) => {
        if (landedRef.current.has(ev.seq)) return
        landedRef.current.set(ev.seq, ev)
        deltaRef.current.set(ev.leaf_id, (deltaRef.current.get(ev.leaf_id) ?? 0) + 1)
        dirtyRef.current = true
      },
      heartbeat: () => {
        beatRef.current = performance.now()
      },
    }),
    [reducedMotion, scheduler],
  )

  const active = phase === "starting" || phase === "running" || (phase === "done" && !published)
  const flowVisible = phase !== "idle" && phase !== "failed" && !flowDismissed

  useEffect(() => {
    if (!published) return
    const timer = window.setTimeout(() => setFlowDismissed(true), FLOW_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [published])

  // ~10 Hz flush of feed + live counts into React; also files events itself
  // when no overlay is ticking (e.g. list view), so the stream always drains.
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => {
      const now = performance.now()
      if (now - beatRef.current > 400) {
        const t = scheduler.tick(now)
        for (const ev of [...t.spawn, ...t.instant]) {
          visual.onSpawn(ev)
          visual.onLand(ev)
          if (t.spawn.includes(ev)) scheduler.land()
        }
      }
      const latest = latestRef.current
      if (latest && now - lastFeedAtRef.current >= FEED_SAMPLE_MS && feedRef.current[0]?.seq !== latest.seq) {
        feedRef.current = [latest, ...feedRef.current].slice(0, FEED_KEEP)
        lastFeedAtRef.current = now
        dirtyRef.current = true
      }
      if (dirtyRef.current) {
        dirtyRef.current = false
        setFeed(feedRef.current)
        setLiveDelta(new Map(deltaRef.current))
        setLandedEvents([...landedRef.current.values()])
      }
      // swap in the published snapshot only once every event has landed
      if (publishRef.current === "waiting" && scheduler.drained && landedRef.current.size >= expectedRef.current) {
        publishRef.current = "done"
        const generation = generationRef.current
        void (async () => {
          for (let i = 0; i < 6; i++) {
            try {
              const s = await api.getSnapshot()
              if (generation !== generationRef.current) return
              if (s.snapshot_id !== baseIdRef.current) {
                deltaRef.current = new Map()
                setLiveDelta(new Map())
                setPublished(true)
                onPublishedRef.current(s)
                return
              }
            } catch {
              // retry below
            }
            await new Promise((r) => setTimeout(r, 500))
            if (generation !== generationRef.current) return
          }
          setError("The new snapshot didn't arrive; reload to see it.")
          setPhase("failed")
        })()
      }
    }, 100)
    return () => window.clearInterval(id)
  }, [active, visual, scheduler])

  // Poll events while the run is going.
  useEffect(() => {
    if (!runId || phase !== "running") return
    let cancelled = false
    let timer: number | undefined
    const ctrl = new AbortController()
    const poll = async () => {
      try {
        const res = await api.getIntakeEvents(runId, lastSeqRef.current, ctrl.signal)
        if (cancelled) return
        if (res.events.length) {
          scheduler.push(res.events, performance.now())
          lastSeqRef.current = Math.max(lastSeqRef.current, ...res.events.map((e) => e.seq))
        }
        setStage(res.stage)
        setRunState(res.state)
        setCounters(res.counters)
        expectedRef.current = res.counters.decided
        // a full page means more events may be waiting: fetch them before finishing
        if (res.events.length >= 200 && res.state !== "failed") {
          timer = window.setTimeout(poll, 50)
          return
        }
        // All pages must be queued before an empty scheduler can mean finished.
        if (res.state === "failed") publishRef.current = "no"
        else if ((res.stage === "evaluating" || res.stage === "done") && publishRef.current === "no") publishRef.current = "waiting"
        if (res.state === "completed" || res.state === "failed") {
          if (publishRef.current === "no" && res.state === "completed") publishRef.current = "waiting"
          try {
            const run = await api.getRun(runId)
            if (cancelled) return
            setSummary(run.intake ?? null)
            if (res.state === "failed") setError(run.error?.message ?? "The intake run failed.")
          } catch (err) {
            if (!cancelled) setError(describeError(err, "Couldn't read the intake result."))
          }
          setPhase(res.state === "completed" ? "done" : "failed")
          void refreshStatus()
          return
        }
        // keep polling even if this batch was empty
        timer = window.setTimeout(poll, INTAKE_POLL_MS)
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return
        timer = window.setTimeout(poll, INTAKE_POLL_MS * 3)
        setError(describeError(err, "Lost contact with the intake run; retrying…"))
      }
    }
    void poll()
    return () => {
      cancelled = true
      ctrl.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [runId, phase, refreshStatus, scheduler])

  const clearLocal = useCallback(() => {
    generationRef.current++
    scheduler.reset()
    feedRef.current = []
    latestRef.current = null
    lastFeedAtRef.current = 0
    deltaRef.current = new Map()
    landedRef.current = new Map()
    expectedRef.current = 0
    lastSeqRef.current = 0
    publishRef.current = "no"
    setFeed([])
    setLiveDelta(new Map())
    setLandedEvents([])
    setFlowDismissed(false)
    setStage(null)
    setRunState(null)
    setCounters(null)
    setSummary(null)
    setPublished(false)
    setError(null)
  }, [scheduler])

  const start = useCallback(async () => {
    clearLocal()
    baseIdRef.current = snapshot?.snapshot_id ?? null
    setPhase("starting")
    try {
      const { run_id } = await api.startIntake()
      setRunId(run_id)
      setPhase("running")
    } catch (err) {
      setError(describeError(err, "The intake couldn't start."))
      setPhase("failed")
    }
  }, [snapshot, clearLocal])

  const reset = useCallback(async () => {
    try {
      await api.resetIntake()
      const s = await api.getSnapshot()
      clearLocal()
      setRunId(null)
      setPhase("idle")
      onPublishedRef.current(s)
      void refreshStatus()
    } catch (err) {
      setError(describeError(err, "Reset failed."))
    }
  }, [refreshStatus, clearLocal])

  const close = useCallback(() => {
    if (phase === "running" || phase === "starting") return
    clearLocal()
    setPhase("idle")
  }, [phase, clearLocal])

  return {
    presenter,
    status,
    phase,
    runId,
    stage,
    runState,
    counters,
    feed,
    liveDelta,
    summary,
    published,
    landedEvents,
    flowVisible,
    error,
    visual,
    start,
    reset,
    close,
    /** a live stream is animating (overlay should be mounted) */
    streaming: phase === "running" || (phase === "done" && !published),
  }
}
