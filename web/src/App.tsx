import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RotateCcw } from "lucide-react"
import { api, describeError, isPause } from "@/lib/api"
import type { Health, Intent, Snapshot } from "@/lib/types"
import { indexSnapshot } from "@/lib/snapshot"
import { isRunActive } from "@/lib/runs"
import { useRun } from "@/hooks/useRun"
import { useSearch } from "@/hooks/useSearch"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AnswerCard } from "@/components/AnswerCard"
import { ClusterList } from "@/components/ClusterList"
import { DetailPanel } from "@/components/DetailPanel"
import { EvalDialog } from "@/components/EvalDialog"
import { Footer, Header, HealthNotice, Toolbar, type View } from "@/components/Chrome"
import { RunDetailsSheet } from "@/components/RunDetailsSheet"
import { MapBar, UsageMap, type Lens } from "@/components/UsageMap"

type Load = { status: "loading" } | { status: "ready"; snapshot: Snapshot } | { status: "error"; message: string }

export default function App() {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [reloadKey, setReloadKey] = useState(0)
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    api
      .getSnapshot(ctrl.signal)
      .then((snapshot) => setLoad({ status: "ready", snapshot }))
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError"))
          setLoad({ status: "error", message: describeError(err, "The snapshot could not be loaded.") })
      })
    api
      .getHealth(ctrl.signal)
      .then((h) => {
        setHealth(h)
        setHealthError(null)
      })
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) setHealthError(describeError(err))
      })
    return () => ctrl.abort()
  }, [reloadKey])

  const snapshot = load.status === "ready" ? load.snapshot : null
  const index = useMemo(() => (snapshot ? indexSnapshot(snapshot) : null), [snapshot])

  // selection & navigation
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [peekId, setPeekId] = useState<string | null>(null)
  const [view, setView] = useState<View>("map")
  const detailRef = useRef<HTMLDivElement>(null)

  const selectLeaf = useCallback((id: string | null) => {
    setSelectedId(id)
    if (id && typeof window !== "undefined" && window.innerWidth < 1024) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }))
    }
  }, [])
  const focusCategory = useCallback((id: string | null) => {
    setFocusId(id)
    if (id) setSelectedId((sel) => sel)
  }, [])

  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 })
  }, [selectedId, focusId])

  // search
  const search = useSearch(snapshot)
  const matchInfo = {
    active: search.highlight.active,
    empty: search.highlight.empty,
    count: search.highlight.matchCount,
    partial: search.highlight.clusters.size - search.highlight.matchCount,
  }

  // question runs
  const [runIds, setRunIds] = useState<Record<Intent, string | null>>({ usage: null, friction: null })
  const [startError, setStartError] = useState<Record<Intent, { message: string; paused: boolean } | null>>({ usage: null, friction: null })
  const [activeIntent, setActiveIntent] = useState<Intent | null>(null)
  const usage = useRun(runIds.usage)
  const friction = useRun(runIds.friction)
  const runs = { usage, friction }
  const [sheetOpen, setSheetOpen] = useState(false)
  const [evalOpen, setEvalOpen] = useState(false)

  const start = useCallback(
    async (intent: Intent) => {
      if (!snapshot) return
      setActiveIntent(intent)
      setStartError((e) => ({ ...e, [intent]: null }))
      setRunIds((r) => ({ ...r, [intent]: null }))
      try {
        const { run_id } = await api.startAnalysis({ intent, snapshot_id: snapshot.snapshot_id })
        setRunIds((r) => ({ ...r, [intent]: run_id }))
      } catch (err) {
        setStartError((e) => ({ ...e, [intent]: { message: describeError(err, "The analysis could not start."), paused: isPause(err) } }))
      }
    },
    [snapshot],
  )

  const ask = (intent: Intent) => {
    const current = runs[intent].run
    // A run in flight or already answered is simply shown again.
    if (runIds[intent] && (!current || isRunActive(current) || current.state === "completed")) {
      setActiveIntent(intent)
      return
    }
    void start(intent)
  }

  const activeRun = activeIntent ? runs[activeIntent].run : null
  const lens: Lens = activeIntent === "friction" && friction.run?.state === "completed" ? "friction" : "usage"

  if (load.status === "error") {
    return (
      <Shell snapshot={null} onEval={() => {}}>
        <div className="grid flex-1 place-items-center p-8">
          <div role="alert" className="max-w-md rounded-xl border bg-card p-6 text-center">
            <h1 className="text-[16px] font-semibold">The snapshot couldn't be loaded</h1>
            <p className="mt-1.5 text-[13.5px] text-muted-foreground">{load.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => { setLoad({ status: "loading" }); setReloadKey((k) => k + 1) }}>
              <RotateCcw />
              Try again
            </Button>
          </div>
        </div>
      </Shell>
    )
  }

  return (
    <Shell snapshot={snapshot} onEval={() => setEvalOpen(true)}>
      <Toolbar
        query={search.query}
        onQuery={search.setQuery}
        onClear={search.clear}
        searching={search.loading}
        searchError={search.error}
        matchInfo={matchInfo}
        activeIntent={activeIntent}
        running={{ usage: isRunActive(usage.run), friction: isRunActive(friction.run) }}
        onAsk={ask}
        view={view}
        onView={setView}
        disabled={!index}
        notice={<HealthNotice health={health} error={healthError} snapshotId={snapshot?.snapshot_id} />}
      />

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 px-4 pb-3 lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]">
        <section
          aria-label={view === "map" ? "Usage map" : "Workflow list"}
          className="relative overflow-hidden rounded-xl border bg-card lg:min-h-0"
        >
          {!index ? (
            <MapSkeleton />
          ) : view === "map" ? (
            <UsageMap
              index={index}
              lens={lens}
              highlight={search.highlight}
              selectedId={selectedId}
              focusId={focusId}
              peekId={peekId}
              onSelectLeaf={selectLeaf}
              onFocusCategory={focusCategory}
            />
          ) : (
            <div className="flex h-full min-h-[440px] flex-col">
              <MapBar index={index} focusNode={focusId ? (index.byId.get(focusId) ?? null) : null} onFocusCategory={focusCategory} lens={lens} />
              <div className="min-h-0 flex-1">
                <ClusterList index={index} lens={lens} highlight={search.highlight} selectedId={selectedId} focusId={focusId} onSelectLeaf={selectLeaf} />
              </div>
            </div>
          )}
          {index && search.highlight.active && search.highlight.empty ? (
            <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center">
              <div role="status" className="rounded-full border bg-card/95 px-3.5 py-1.5 text-[12.5px] shadow-xs backdrop-blur-sm">
                No matching published insights for “{search.query.trim()}”
              </div>
            </div>
          ) : null}
        </section>

        <aside aria-label="Details" className="flex min-h-0 flex-col gap-3">
          {index && activeIntent ? (
            <AnswerCard
              key={activeIntent}
              intent={activeIntent}
              run={activeRun}
              error={startError[activeIntent]?.message ?? runs[activeIntent].error}
              paused={!!startError[activeIntent]?.paused}
              index={index}
              selectedId={selectedId}
              onSelectCluster={(id) => {
                if (focusId && index.byId.get(id)?.parent_id !== focusId) setFocusId(null)
                selectLeaf(id)
              }}
              onPeek={setPeekId}
              onOpenDetails={() => setSheetOpen(true)}
              onRunAgain={() => void start(activeIntent)}
              onClose={() => {
                setActiveIntent(null)
                setPeekId(null)
              }}
            />
          ) : null}
          <div
            ref={detailRef}
            className="min-h-[240px] flex-1 scroll-mt-3 rounded-xl border bg-card px-5 py-4 lg:overflow-y-auto"
          >
            {index ? (
              <DetailPanel index={index} selectedId={selectedId} focusId={focusId} onSelectLeaf={selectLeaf} onFocusCategory={focusCategory} />
            ) : (
              <DetailSkeleton />
            )}
          </div>
        </aside>
      </main>

      {snapshot ? <RunDetailsSheet open={sheetOpen} onOpenChange={setSheetOpen} run={activeRun} snapshot={snapshot} /> : null}
      <EvalDialog open={evalOpen} onOpenChange={setEvalOpen} />
    </Shell>
  )
}

function Shell({ snapshot, onEval, children }: { snapshot: Snapshot | null; onEval: () => void; children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex min-h-dvh flex-col lg:h-dvh">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
          Skip to content
        </a>
        <Header snapshot={snapshot} mock={api.mode === "mock"} />
        <div id="main" className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
        <Footer snapshot={snapshot} mock={api.mode === "mock"} onEval={onEval} />
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}

function MapSkeleton() {
  return (
    <div className="grid h-full min-h-[440px] place-items-center" aria-busy aria-label="Loading map">
      <div className="relative size-[min(70%,480px)] max-h-[80%]">
        <Skeleton className="absolute inset-0 rounded-full opacity-60" />
        <Skeleton className="absolute top-[12%] left-[14%] size-[38%] rounded-full" />
        <Skeleton className="absolute top-[18%] right-[12%] size-[30%] rounded-full" />
        <Skeleton className="absolute bottom-[12%] left-[30%] size-[34%] rounded-full" />
      </div>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy aria-label="Loading details">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  )
}
