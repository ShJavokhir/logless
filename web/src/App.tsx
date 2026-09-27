import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Radio, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { api, describeError, isPause } from "@/lib/api"
import type { Health, Snapshot } from "@/lib/types"
import { highlightFromRows, NO_HIGHLIGHT } from "@/lib/search"
import { indexSnapshot } from "@/lib/snapshot"
import { layoutOrderOf } from "@/lib/hierarchy"
import { formatDelta, pickToastDeltas } from "@/lib/intake"
import { proseName } from "@/lib/labels"
import { fmtInt } from "@/lib/format"
import { useIntake } from "@/hooks/useIntake"
import { IntakePanel } from "@/components/IntakePanel"
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

  // The first snapshot of a build pins packing order, rotation and category
  // hues, so later snapshots (live intake) grow in place instead of reshuffling.
  const [layoutBase, setLayoutBase] = useState<Snapshot | null>(null)
  const sameBuild = (a: Snapshot, b: Snapshot) =>
    a.clusters.length === b.clusters.length && a.clusters.every((c) => b.clusters.some((d) => d.id === c.id))
  if (snapshot && (!layoutBase || !sameBuild(layoutBase, snapshot))) setLayoutBase(snapshot)
  const hueOrder = useMemo(() => (layoutBase ? layoutOrderOf(layoutBase) : undefined), [layoutBase])
  const index = useMemo(() => (snapshot ? indexSnapshot(snapshot, hueOrder) : null), [snapshot, hueOrder])

  const refreshHealth = useCallback(() => {
    api.getHealth().then(
      (h) => {
        setHealth(h)
        setHealthError(null)
      },
      (err) => setHealthError(describeError(err)),
    )
  }, [])
  const onPublished = useCallback(
    (s: Snapshot) => {
      setLoad({ status: "ready", snapshot: s })
      refreshHealth()
    },
    [refreshHealth],
  )
  const intake = useIntake(snapshot, onPublished)
  const intakeActive = intake.phase !== "idle"

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

  // §0: the map lens is a view of published data (no run); asking is the one live action.
  const [lens, setLens] = useState<Lens>("usage")
  const [askOpen, setAskOpen] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [startError, setStartError] = useState<{ message: string; paused: boolean } | null>(null)
  const [asking, setAsking] = useState(false)
  const question = useRun(runId)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [evalOpen, setEvalOpen] = useState(false)

  const askQuestion = useCallback(
    async (text: string) => {
      if (!snapshot) return
      setAskOpen(true)
      setAsking(true)
      setStartError(null)
      setRunId(null)
      try {
        const { run_id } = await api.startAnalysis({ intent: "question", question: text.slice(0, 200), snapshot_id: snapshot.snapshot_id })
        setRunId(run_id)
      } catch (err) {
        setStartError({ message: describeError(err, "The question could not be sent."), paused: isPause(err) })
      } finally {
        setAsking(false)
      }
    },
    [snapshot],
  )

  const askAnother = () => {
    setRunId(null)
    setStartError(null)
  }

  const activeRun = askOpen ? question.run : null

  // A verified question result lights up its rows' nodes (search wins while active).
  const questionRows =
    askOpen && question.run?.state === "completed" && question.run.result?.intent === "question" ? question.run.result.rows : null
  const questionHighlight = useMemo(
    () => (questionRows && snapshot ? highlightFromRows(questionRows.map((r) => r.id), snapshot.clusters) : NO_HIGHLIGHT),
    [questionRows, snapshot],
  )
  const highlight = search.highlight.active ? search.highlight : questionHighlight

  // Live intake (presenter-only): start clears the stage so the stream reads cleanly.
  const startIntake = () => {
    setAskOpen(false)
    setFocusId(null)
    setSelectedId(null)
    setPeekId(null)
    setView("map")
    void intake.start()
  }

  // Completion toast, once per run, after the map has swapped to the new snapshot.
  const toastedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!intake.published || !intake.summary || !index || toastedRef.current === intake.runId) return
    toastedRef.current = intake.runId
    const nameOf = (id: string) => {
      const n = index.byId.get(id)
      return n ? proseName(n) : undefined
    }
    toast.success(`Map updated · +${fmtInt(intake.summary.decided)} conversations`, {
      description: (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {pickToastDeltas(intake.summary.deltas, 3).map((d) => (
            <span key={d.id}>{formatDelta(d, nameOf)}</span>
          ))}
        </div>
      ),
      duration: 9000,
    })
  }, [intake.published, intake.summary, intake.runId, index])

  const intakeControl = !intake.presenter ? null : intake.phase !== "idle" ? (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft px-2 py-0.5 text-[12px] font-medium text-brand">
      <Radio aria-hidden className="size-3.5" />
      {intake.phase === "running" || intake.phase === "starting" ? "Live intake running" : "Live intake"}
    </span>
  ) : intake.status?.ready ? (
    <Button size="sm" variant="outline" className="h-7 border-brand/40 text-brand hover:bg-brand-soft" onClick={startIntake}>
      <Radio />
      Live intake
    </Button>
  ) : intake.status ? (
    <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => void intake.reset()}>
      <RotateCcw />
      Reset intake
    </Button>
  ) : null

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
        askOpen={askOpen}
        asking={asking || isRunActive(question.run)}
        onOpenAsk={() => setAskOpen(true)}
        view={view}
        onView={setView}
        disabled={!index}
        notice={<HealthNotice health={health} error={healthError} snapshotId={intakeActive ? undefined : snapshot?.snapshot_id} />}
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
              highlight={highlight}
              selectedId={selectedId}
              focusId={focusId}
              peekId={peekId}
              onSelectLeaf={selectLeaf}
              onFocusCategory={focusCategory}
              onLens={setLens}
              layoutBase={layoutBase}
              liveDelta={intake.liveDelta}
              intake={intake.streaming ? { visual: intake.visual, decided: intake.counters?.decided ?? 0, total: intake.counters?.total ?? intake.status?.batch_size ?? 0 } : null}
              headerControl={intakeControl}
            />
          ) : (
            <div className="flex h-full min-h-[440px] flex-col">
              <MapBar
                index={index}
                focusNode={focusId ? (index.byId.get(focusId) ?? null) : null}
                onFocusCategory={focusCategory}
                lens={lens}
                onLens={setLens}
                extra={intakeControl}
              />
              <div className="min-h-0 flex-1">
                <ClusterList index={index} lens={lens} highlight={highlight} selectedId={selectedId} focusId={focusId} onSelectLeaf={selectLeaf} />
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
          {index && askOpen && !intakeActive ? (
            <AnswerCard
              run={activeRun}
              error={startError?.message ?? question.error}
              paused={!!startError?.paused}
              index={index}
              selectedId={selectedId}
              onSelectCluster={(id) => {
                if (focusId && index.byId.get(id)?.parent_id !== focusId) setFocusId(null)
                selectLeaf(id)
              }}
              onFocusCategory={(id) => {
                setSelectedId(null)
                focusCategory(id)
              }}
              onPeek={setPeekId}
              onOpenDetails={() => setSheetOpen(true)}
              onAsk={(q) => void askQuestion(q)}
              onAskAnother={askAnother}
              asking={asking}
              onClose={() => {
                setAskOpen(false)
                setPeekId(null)
              }}
            />
          ) : null}
          <div
            ref={detailRef}
            className="min-h-[240px] flex-1 scroll-mt-3 rounded-xl border bg-card px-5 py-4 lg:overflow-y-auto"
          >
            {index && intakeActive ? (
              <IntakePanel intake={intake} index={index} />
            ) : index ? (
              <DetailPanel
                index={index}
                selectedId={selectedId}
                focusId={focusId}
                onSelectLeaf={selectLeaf}
                onFocusCategory={focusCategory}
                onShowFinding={(catId, leafId) => {
                  setFocusId(catId)
                  if (leafId) selectLeaf(leafId)
                }}
                onAsk={(q) => void askQuestion(q)}
              />
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
        <Header snapshot={snapshot} />
        <div id="main" className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
        <Footer snapshot={snapshot} mock={api.mode === "mock"} onEval={onEval} />
      </div>
      <Toaster position="bottom-left" />
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
