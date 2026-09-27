import { useCallback, useEffect, useMemo, useState } from "react"
import { LayoutGrid, RotateCcw } from "lucide-react"
import { api, describeError } from "@/lib/api"
import type { Snapshot } from "@/lib/types"
import { indexSnapshot } from "@/lib/snapshot"
import { layoutOrderOf } from "@/lib/hierarchy"
import { cn } from "@/lib/utils"
import { useIntake } from "@/hooks/useIntake"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Wordmark } from "@/components/Chrome"
import { EXPLORE_HREF, TABS, hrefOf, type Tab } from "./route"
import { DataTab } from "./DataTab"
import { LoggyTab } from "./LoggyTab"
import { BuildTab, type BuildTarget } from "./BuildTab"

type Load = { status: "loading" } | { status: "ready"; snapshot: Snapshot } | { status: "error"; message: string }

export function StoryApp({ tab }: { tab: Tab }) {
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

  // The first snapshot of a build pins category hues, so a live intake grows the map in place.
  const [layoutBase, setLayoutBase] = useState<Snapshot | null>(null)
  const sameBuild = (a: Snapshot, b: Snapshot) => a.clusters.length === b.clusters.length && a.clusters.every((c) => b.clusters.some((d) => d.id === c.id))
  if (snapshot && (!layoutBase || !sameBuild(layoutBase, snapshot))) setLayoutBase(snapshot)
  const hueOrder = useMemo(() => (layoutBase ? layoutOrderOf(layoutBase) : undefined), [layoutBase])
  const index = useMemo(() => (snapshot ? indexSnapshot(snapshot, hueOrder) : null), [snapshot, hueOrder])

  const onPublished = useCallback((s: Snapshot) => setLoad({ status: "ready", snapshot: s }), [])
  const intake = useIntake(snapshot, onPublished)

  // Loggy hands a workflow to Build; Build drafts its story and prompt right away.
  const [buildTarget, setBuildTarget] = useState<BuildTarget | null>(null)
  const buildFor = useCallback((target: BuildTarget) => {
    setBuildTarget(target)
    window.location.hash = hrefOf("build")
  }, [])

  // ← → move between tabs (not while typing, not over a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
      const t = e.target as HTMLElement | null
      // An empty field still lets arrows through (the Loggy box takes focus on arrival).
      const field = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
      if (t && (t.isContentEditable || t.tagName === "SELECT" || (field && t.value !== ""))) return
      if (document.querySelector("[role=dialog]")) return
      const i = TABS.findIndex((x) => x.id === tab) + (e.key === "ArrowRight" ? 1 : -1)
      if (i < 0 || i >= TABS.length) return
      e.preventDefault()
      window.location.hash = hrefOf(TABS[i].id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [tab])

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-dvh min-h-[560px] flex-col bg-background">
        <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b bg-card px-4 sm:px-6">
          <a href={hrefOf("data")} aria-label="logless, back to the start" className="justify-self-start">
            <Wordmark />
          </a>
          <nav aria-label="Demo" className="flex items-center gap-1 rounded-full bg-muted p-1">
            {TABS.map((t, i) => (
              <a
                key={t.id}
                href={hrefOf(t.id)}
                aria-current={t.id === tab ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-[13.5px] font-medium transition-colors",
                  t.id === tab ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className={cn("font-mono text-[11px] tabular-nums", t.id === tab ? "text-brand" : "text-subtle")}>{i + 1}</span>
                {t.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-3 justify-self-end">
            <a href="#/how-it-works" className="text-[12.5px] text-muted-foreground hover:text-foreground">How it works</a>
            <a
              href={EXPLORE_HREF}
              aria-label="Open the workspace"
              title="Open the workspace"
              className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LayoutGrid aria-hidden className="size-4" />
            </a>
          </div>
        </header>

        <main className="relative min-h-0 flex-1">
          {load.status === "error" ? (
            <div className="grid h-full place-items-center p-8">
              <div role="alert" className="max-w-md rounded-xl border bg-card p-6 text-center">
                <h1 className="text-[16px] font-semibold">The snapshot couldn't be loaded</h1>
                <p className="mt-1.5 text-[13.5px] text-muted-foreground">{load.message}</p>
                <Button
                  className="mt-4"
                  variant="outline"
                  onClick={() => {
                    setLoad({ status: "loading" })
                    setReloadKey((k) => k + 1)
                  }}
                >
                  <RotateCcw />
                  Try again
                </Button>
              </div>
            </div>
          ) : !index ? (
            <div className="grid h-full place-items-center text-[13px] text-muted-foreground" aria-busy>
              Loading…
            </div>
          ) : (
            // Tabs stay mounted so a running intake, the chat and a drafting PRD survive switching.
            <>
              <TabPanel active={tab === "data"}>
                <DataTab index={index} intake={intake} active={tab === "data"} />
              </TabPanel>
              <TabPanel active={tab === "loggy"}>
                <LoggyTab index={index} active={tab === "loggy"} onBuild={buildFor} />
              </TabPanel>
              <TabPanel active={tab === "build"}>
                <BuildTab index={index} target={buildTarget} />
              </TabPanel>
            </>
          )}
        </main>
      </div>
      <Toaster position="bottom-left" />
    </TooltipProvider>
  )
}

function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div hidden={!active} inert={!active} className={cn("absolute inset-0", active && "animate-in fade-in-0 duration-200 motion-reduce:animate-none")}>
      {children}
    </div>
  )
}
