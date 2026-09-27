// Video brief: a one-minute summary of the published map, directed by GLM 5.3 and
// played by a Remotion composition. The storyboard rail seeks the player, and
// "Direct a new cut" runs the director again (reading → directing → checking).

import { useCallback, useEffect, useRef, useState } from "react"
import { Player, type PlayerRef } from "@remotion/player"
import { CircleCheck, Clapperboard, Download, LoaderCircle, RotateCcw, Sparkles } from "lucide-react"
import { api, describeError } from "@/lib/api"
import type { RunStage } from "@/lib/types"
import { fmtClock } from "@/lib/format"
import { useRun } from "@/hooks/useRun"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { BriefVideo } from "@/video/BriefVideo"
import { modelName } from "@/video/anim"
import type { Brief, BriefResponse, Scene } from "@/video/types"

type Phase =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "requesting" }
  | { kind: "pending"; runId: string }
  | { kind: "ready"; brief: Brief }
  | { kind: "error"; message: string }

const SCENE_LABEL: Record<Scene["type"], string> = {
  intro: "Intro",
  change: "What changed",
  map: "Usage map",
  top_workflows: "Top workflows",
  friction: "Friction",
  signals: "Signals",
  spotlight: "Spotlight",
  languages: "Languages",
  takeaways: "Takeaways",
  outro: "Receipts",
}

const STAGE_LABEL: Record<string, string> = {
  reading: "Read the published map",
  directing: "Direct the storyboard",
  checking: "Check every word and number",
}

export function BriefDialog({ open, onOpenChange, snapshotId }: { open: boolean; onOpenChange: (o: boolean) => void; snapshotId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [previous, setPrevious] = useState<Brief | null>(null)
  const pendingId = phase.kind === "pending" ? phase.runId : null
  const { run, error: runError } = useRun(pendingId)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const apply = useCallback((res: BriefResponse) => {
    if (!alive.current) return
    if (res.status === "ready") setPhase({ kind: "ready", brief: res.brief })
    else if (res.status === "pending") setPhase({ kind: "pending", runId: res.run_id })
    else setPhase({ kind: "none" })
  }, [])
  const fail = useCallback(
    (err: unknown) => alive.current && setPhase({ kind: "error", message: describeError(err, "The video brief could not be loaded.") }),
    [],
  )

  // Load the latest brief for this snapshot whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    api.getBrief(snapshotId, ctrl.signal).then(
      (res) => !ctrl.signal.aborted && setPhase((p) => (p.kind === "pending" || p.kind === "requesting" ? p : phaseOf(res))),
      (err) => !ctrl.signal.aborted && fail(err),
    )
    return () => ctrl.abort()
  }, [open, snapshotId, fail])

  // When the director's run completes, fetch the new cut.
  const completedRunId = run?.state === "completed" ? run.run_id : null
  useEffect(() => {
    if (!completedRunId || completedRunId !== pendingId) return
    let cancelled = false
    api.getBrief(snapshotId).then(
      (res) => !cancelled && apply(res),
      (err) => !cancelled && fail(err),
    )
    return () => {
      cancelled = true
    }
  }, [completedRunId, pendingId, snapshotId, apply, fail])

  // While the MP4 export renders on the server, refresh the brief every few seconds.
  const rendering = phase.kind === "ready" && phase.brief.video_status === "rendering" ? phase.brief.brief_id : null
  useEffect(() => {
    if (!rendering) return
    const t = setInterval(() => {
      api.getBrief(snapshotId).then(
        (res) => {
          if (!alive.current || res.status !== "ready" || res.brief.brief_id !== rendering) return
          if (res.brief.video_status !== "rendering") setPhase({ kind: "ready", brief: res.brief })
        },
        () => {},
      )
    }, 4000)
    return () => clearInterval(t)
  }, [rendering, snapshotId])

  const direct = (regenerate: boolean) => {
    if (phase.kind === "ready") setPrevious(phase.brief)
    setPhase({ kind: "requesting" })
    api.requestBrief(snapshotId, regenerate).then(apply, fail)
  }

  const runFailed = phase.kind === "pending" && run?.state === "failed"
  const busy = (phase.kind === "requesting" || phase.kind === "pending") && !runFailed && !runError
  const errorMessage =
    phase.kind === "error" ? phase.message : runFailed ? (run?.error?.message ?? "The director could not finish this cut.") : runError

  const brief = phase.kind === "ready" ? phase.brief : null
  const shown = brief ?? (errorMessage && previous ? previous : null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94vh] w-[min(1240px,96vw)] gap-0 overflow-y-auto p-0 sm:max-w-[min(1240px,96vw)]">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_330px]">
          <div className="p-4 lg:p-5">
            <div className="mb-3 flex items-start gap-3 pr-8">
              <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground text-background">
                <Clapperboard className="size-4" />
              </div>
              <div>
                <DialogTitle className="text-[15px] font-semibold">Video brief</DialogTitle>
                <DialogDescription className="text-[12.5px] leading-snug">
                  A one-minute summary of the published map. GLM 5.3 on Vultr directs the storyboard and writes the words. Every number
                  on screen is filled from published metrics by code, never by the model.
                </DialogDescription>
              </div>
            </div>
            <Stageboard
              phase={phase}
              shown={shown}
              busy={busy}
              stages={run?.stages ?? []}
              errorMessage={errorMessage}
              onDirect={() => direct(false)}
              onRetry={() => direct(true)}
            />
          </div>
          <aside className="border-t bg-muted/30 p-4 lg:border-t-0 lg:border-l lg:p-5">
            <Rail brief={shown} busy={busy} onRegenerate={() => direct(true)} />
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function phaseOf(res: BriefResponse): Phase {
  if (res.status === "ready") return { kind: "ready", brief: res.brief }
  if (res.status === "pending") return { kind: "pending", runId: res.run_id }
  return { kind: "none" }
}

/* ------------------------------------------------------------ player / states */

// The player instance lives here so the rail can seek it.
let playerHandle: PlayerRef | null = null
const frameListeners = new Set<(f: number) => void>()

function Stageboard({
  phase,
  shown,
  busy,
  stages,
  errorMessage,
  onDirect,
  onRetry,
}: {
  phase: Phase
  shown: Brief | null
  busy: boolean
  stages: RunStage[]
  errorMessage: string | null
  onDirect: () => void
  onRetry: () => void
}) {
  const setRef = useCallback((p: PlayerRef | null) => {
    playerHandle = p
    if (!p) return
    const onFrame = (e: { detail: { frame: number } }) => frameListeners.forEach((l) => l(e.detail.frame))
    p.addEventListener("frameupdate", onFrame)
  }, [])

  const frame = "relative aspect-video w-full overflow-hidden rounded-xl bg-[oklch(0.155_0.008_265)] text-[oklch(0.97_0.004_265)]"

  if (busy) return <Directing stages={stages} className={frame} />
  if (shown) {
    return (
      <div>
        <div className={frame}>
          <Player
            key={shown.brief_id}
            ref={setRef}
            component={BriefVideo}
            inputProps={{ brief: shown }}
            durationInFrames={shown.duration_frames}
            fps={shown.fps}
            compositionWidth={shown.width}
            compositionHeight={shown.height}
            style={{ width: "100%", height: "100%" }}
            controls
            showVolumeControls={false}
            autoPlay
            clickToPlay
            doubleClickToFullscreen
            acknowledgeRemotionLicense
          />
        </div>
        {errorMessage ? (
          <p role="alert" className="mt-2 text-[12.5px] text-destructive">
            {errorMessage} Showing the previous cut.
          </p>
        ) : null}
        {shown.metrics_used.length ? (
          <div className="mt-3">
            <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Numbers in the words · filled by code from published metrics
            </div>
            <div className="flex flex-wrap gap-1.5">
              {shown.metrics_used.map((m) => (
                <span key={m.name} className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 text-[11.5px]">
                  <span className="font-mono text-muted-foreground">{`{${m.name.split(" · ")[0]}}`}</span>
                  {m.name.includes(" · ") ? <span className="text-muted-foreground">{m.name.split(" · ").slice(1).join(" · ")}</span> : null}
                  <span className="font-medium">{m.value}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <p className="mt-2 text-[11.5px] leading-snug text-muted-foreground">
          The model reads rounded published aggregates to choose scenes and words, but may not write a digit; every number on
          screen, in the words and in the charts, is filled by code from the snapshot.
        </p>
      </div>
    )
  }
  return (
    <div className={cn(frame, "grid place-items-center p-6 text-center")}>
      {phase.kind === "loading" ? (
        <LoaderCircle className="size-6 animate-spin opacity-60" aria-label="Loading" />
      ) : (
        <div className="flex max-w-md flex-col items-center gap-4">
          <Sparkles className="size-7 opacity-70" />
          <p className="text-[15px] leading-snug opacity-90">
            {errorMessage ?? "No video brief for this snapshot yet. The director reads the published map and cuts a one-minute video in about half a minute."}
          </p>
          <Button variant="secondary" onClick={errorMessage ? onRetry : onDirect}>
            {errorMessage ? <RotateCcw /> : <Clapperboard />}
            {errorMessage ? "Try again" : "Direct the video"}
          </Button>
        </div>
      )}
    </div>
  )
}

function Directing({ stages, className }: { stages: RunStage[]; className: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  const started = stages.find((s) => s.started_at)?.started_at
  const elapsed = started ? Math.max(0, (now - Date.parse(started)) / 1000) : 0
  const rows = stages.length ? stages : ["reading", "directing", "checking"].map((name) => ({ name, status: "pending" }) as RunStage)
  return (
    <div className={cn(className, "flex flex-col justify-center gap-6 px-[7%]")} role="status" aria-live="polite">
      <div className="flex items-baseline gap-3">
        <span className="text-[26px] font-semibold tracking-tight">Directing your video brief</span>
        <span className="font-mono text-[13px] opacity-60">{elapsed.toFixed(1)} s</span>
      </div>
      <ol className="flex flex-col gap-3">
        {rows.map((s, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-0.5 grid size-5 place-items-center">
              {s.status === "done" ? (
                <CircleCheck className="size-5 text-[oklch(0.8_0.12_185)]" />
              ) : s.status === "running" ? (
                <LoaderCircle className="size-5 animate-spin" />
              ) : s.status === "failed" ? (
                <span className="size-3 rounded-full bg-[oklch(0.74_0.16_50)]" />
              ) : (
                <span className="size-2.5 rounded-full bg-white/25" />
              )}
            </span>
            <div className={cn("min-w-0", s.status === "pending" && "opacity-45")}>
              <div className="text-[15px] font-medium">
                {STAGE_LABEL[s.name] ?? s.name}
                {s.status === "failed" ? <span className="ml-2 text-[12px] text-[oklch(0.74_0.16_50)]">rejected · one repair</span> : null}
              </div>
              {s.detail ? <div className="mt-0.5 line-clamp-2 text-[12.5px] opacity-65">{s.detail}</div> : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="max-w-xl text-[12px] leading-snug opacity-55">
        GLM 5.3 sees only published aggregates, never a conversation. It may not write a single digit: numbers are placeholders that
        code fills from verified metrics, and a gate rejects any storyboard that breaks the rules.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------ rail */

function useCurrentFrame() {
  const [f, setF] = useState(0)
  useEffect(() => {
    frameListeners.add(setF)
    return () => {
      frameListeners.delete(setF)
    }
  }, [])
  return f
}

function Rail({ brief, busy, onRegenerate }: { brief: Brief | null; busy: boolean; onRegenerate: () => void }) {
  const frame = useCurrentFrame()
  if (!brief) {
    return (
      <div className="text-[12.5px] leading-relaxed text-muted-foreground">
        <h3 className="mb-2 text-[13px] font-medium text-foreground">How the director works</h3>
        <ol className="list-decimal space-y-1.5 pl-4">
          <li>Code turns the published map into a facts sheet of aggregates.</li>
          <li>GLM 5.3 picks the scenes, their order and length, and writes the words.</li>
          <li>A gate checks scene rules, ids, placeholders and privacy, with one repair round.</li>
          <li>Code fills every number and attaches the chart data; Remotion plays it.</li>
        </ol>
      </div>
    )
  }
  const seek = (f: number) => {
    playerHandle?.seekTo(f)
    playerHandle?.play()
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-[14px] leading-snug font-semibold">{brief.title}</h3>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {modelName(brief.model)} · {fmtClock(brief.generated_at)} · {brief.attempts === 1 ? "passed first try" : `passed after ${brief.attempts - 1} repair`}
        </p>
      </div>

      <section aria-labelledby="sb-h">
        <h4 id="sb-h" className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Storyboard · {brief.scenes.length} scenes · {Math.round(brief.duration_frames / brief.fps)} s
        </h4>
        <ol className="flex flex-col gap-0.5">
          {brief.scenes.map((s, i) => {
            const active = frame >= s.from_frame && frame < s.from_frame + s.frames
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => seek(s.from_frame)}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                    active && "bg-background shadow-xs ring-1 ring-foreground/10",
                  )}
                >
                  <div className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    <span className="uppercase">{SCENE_LABEL[s.type]}</span>
                    <span className="ml-auto">{s.seconds}s</span>
                  </div>
                  <div className="text-[12.5px] leading-snug">{s.headline}</div>
                </button>
              </li>
            )
          })}
        </ol>
      </section>

      {brief.checks.length ? (
        <section aria-labelledby="ck-h">
          <h4 id="ck-h" className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Gate
          </h4>
          <ul className="flex flex-col gap-1">
            {brief.checks.map((c, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] leading-snug">
                <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                {c}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onRegenerate} disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
          Direct a new cut
        </Button>
        {brief.video_url ? (
          <Button variant="outline" size="sm" asChild>
            <a href={brief.video_url} download>
              <Download />
              Download MP4
            </a>
          </Button>
        ) : brief.video_status === "rendering" ? (
          <Button variant="outline" size="sm" disabled>
            <LoaderCircle className="animate-spin" />
            Rendering MP4…
          </Button>
        ) : null}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{brief.label}</p>
    </div>
  )
}
