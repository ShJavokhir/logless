import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowLeft, ArrowRight, LayoutGrid, RotateCcw } from "lucide-react"
import { api, describeError } from "@/lib/api"
import type { Snapshot } from "@/lib/types"
import { indexSnapshot } from "@/lib/snapshot"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Wordmark } from "@/components/Chrome"
import { presenterKey } from "@/lib/presenter"
import { RemoteButton } from "@/remote/RemoteButton"
import { ASK_BEATS, EXPLORE_HREF, ORGANIZE_BEATS, STEPS, hrefOf } from "./route"
import { Intro } from "./Intro"
import { Organize } from "./Organize"
import { Ask } from "./Ask"
import { Build } from "./Build"

type Load = { status: "loading" } | { status: "ready"; snapshot: Snapshot } | { status: "error"; message: string }

/** Beats per step: → reveals the next beat, then moves to the next step. */
const BEATS = [1, ORGANIZE_BEATS.length, ASK_BEATS.length, 1]

export function StoryApp({ step }: { step: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    const ctrl = new AbortController()
    api.getSnapshot(ctrl.signal).then(
      (snapshot) => setLoad({ status: "ready", snapshot }),
      (err) => {
        if (!(err instanceof DOMException && err.name === "AbortError"))
          setLoad({ status: "error", message: describeError(err, "The snapshot could not be loaded.") })
      },
    )
    return () => ctrl.abort()
  }, [reloadKey])
  const snapshot = load.status === "ready" ? load.snapshot : null
  const index = useMemo(() => (snapshot ? indexSnapshot(snapshot) : null), [snapshot])

  // Beat within the current step; entering a step backwards lands on its last beat.
  const [beat, setBeat] = useState(0)
  const [enterAtEnd, setEnterAtEnd] = useState(false)
  const [shownStep, setShownStep] = useState(step)
  if (shownStep !== step) {
    setShownStep(step)
    setBeat(enterAtEnd ? BEATS[step] - 1 : 0)
    setEnterAtEnd(false)
  }

  const go = useCallback((s: number, atEnd = false) => {
    setEnterAtEnd(atEnd)
    window.location.hash = hrefOf(s)
  }, [])
  const next = useCallback(() => {
    if (beat < BEATS[step] - 1) setBeat(beat + 1)
    else if (step < STEPS.length - 1) go(step + 1)
  }, [beat, step, go])
  const prev = useCallback(() => {
    if (beat > 0) setBeat(beat - 1)
    else if (step > 0) go(step - 1, true)
  }, [beat, step, go])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      // Arrows still move the story from an empty field (the Ask box takes focus on arrival).
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      if (typing && !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ? t.value === "" : false)) return
      if (document.querySelector("[role=dialog]")) return
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault()
        next()
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault()
        prev()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [next, prev])

  const nextLabel =
    beat < BEATS[step] - 1
      ? step === 1
        ? ORGANIZE_BEATS[beat + 1]
        : step === 2
          ? ASK_BEATS[beat + 1]
          : "Next"
      : step < STEPS.length - 1
        ? STEPS[step + 1].label
        : null

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-dvh min-h-[560px] flex-col bg-background">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-card px-4 sm:px-6">
          <a href={hrefOf(0)} aria-label="logless, back to the start">
            <Wordmark />
          </a>
          <nav aria-label="Story" className="mx-auto hidden items-center gap-1 md:flex">
            {STEPS.map((s, i) => (
              <a
                key={s.label}
                href={hrefOf(i)}
                aria-current={i === step ? "step" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-full px-3 text-[13px] transition-colors",
                  i === step ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {i > 0 ? (
                  <span
                    className={cn(
                      "grid size-4.5 place-items-center rounded-full font-mono text-[10.5px]",
                      i === step ? "bg-background/20" : i < step ? "bg-foreground/10 text-foreground" : "border border-current/30",
                    )}
                  >
                    {i}
                  </span>
                ) : null}
                {s.label}
              </a>
            ))}
          </nav>
          <a href="#/how-it-works" className="ml-auto text-[12.5px] text-muted-foreground hover:text-foreground">How it works</a>
          {api.mode === "live" && presenterKey() ? <RemoteButton /> : null}
          <a
            href={EXPLORE_HREF}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:ml-0"
          >
            <LayoutGrid aria-hidden className="size-3.5" />
            Open workspace
          </a>
        </header>

        <main className="relative min-h-0 flex-1 overflow-hidden">
          {load.status === "error" ? (
            <div className="grid h-full place-items-center p-8">
              <div role="alert" className="max-w-md rounded-xl border bg-card p-6 text-center">
                <h1 className="text-[16px] font-semibold">The snapshot couldn't be loaded</h1>
                <p className="mt-1.5 text-[13.5px] text-muted-foreground">{load.message}</p>
                <Button className="mt-4" variant="outline" onClick={() => { setLoad({ status: "loading" }); setReloadKey((k) => k + 1) }}>
                  <RotateCcw />
                  Try again
                </Button>
              </div>
            </div>
          ) : !index ? (
            <div className="grid h-full place-items-center text-[13px] text-muted-foreground" aria-busy>
              Loading the published snapshot…
            </div>
          ) : (
            <div key={step} className="h-full animate-in fade-in-0 duration-300 motion-reduce:animate-none">
              {step === 0 ? <Intro index={index} onStart={() => go(1)} /> : null}
              {step === 1 ? <Organize index={index} beat={beat} onBeat={setBeat} /> : null}
              {step === 2 ? <Ask index={index} beat={beat} onBeat={setBeat} /> : null}
              {step === 3 ? <Build index={index} /> : null}
            </div>
          )}
        </main>

        <footer className="flex h-12 shrink-0 items-center gap-3 border-t bg-card px-4 text-[12.5px] sm:px-6">
          <Button variant="ghost" size="sm" onClick={prev} disabled={step === 0 && beat === 0} aria-label="Back">
            <ArrowLeft />
            <span className="hidden sm:inline">Back</span>
          </Button>
          {BEATS[step] > 1 ? (
            <div className="flex items-center gap-1.5" aria-label={`Part ${beat + 1} of ${BEATS[step]}`}>
              {Array.from({ length: BEATS[step] }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setBeat(i)}
                  aria-label={`Part ${i + 1}`}
                  className={cn("h-1.5 rounded-full transition-all", i === beat ? "w-5 bg-foreground" : "w-1.5 bg-foreground/20 hover:bg-foreground/40")}
                />
              ))}
            </div>
          ) : null}
          <span className="hidden text-muted-foreground lg:inline">
            <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">←</kbd>{" "}
            <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">→</kbd> to move
          </span>
          <div className="ml-auto">
            {nextLabel ? (
              <Button size="sm" onClick={next}>
                {nextLabel}
                <ArrowRight />
              </Button>
            ) : (
              <Button size="sm" asChild>
                <a href={EXPLORE_HREF}>
                  Open the workspace
                  <ArrowRight />
                </a>
              </Button>
            )}
          </div>
        </footer>
      </div>
      <Toaster position="bottom-left" />
    </TooltipProvider>
  )
}
