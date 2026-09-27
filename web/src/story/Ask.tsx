import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Clock, Cpu, KeyRound, RotateCcw, ShieldCheck } from "lucide-react"
import { api, describeError, isPause } from "@/lib/api"
import type { SnapshotIndex } from "@/lib/snapshot"
import { createLatestGuard, highlightFromRows, NO_HIGHLIGHT } from "@/lib/search"
import { hasVerifiedResult } from "@/lib/runs"
import { useRun } from "@/hooks/useRun"
import { AnswerCard } from "@/components/AnswerCard"
import { Containment, RunDetailsSheet } from "@/components/RunDetailsSheet"
import { UsageMap, type Lens } from "@/components/UsageMap"
import { takePendingQuestion } from "./handoff"
import { Lead } from "./Lead"
import { Architecture } from "./Intro"

// The last question survives leaving the step (e.g. to Build and back).
let lastRunId: string | null = null

export function Ask({ index, beat }: { index: SnapshotIndex; beat: number; onBeat: (b: number) => void }) {
  const snapshot = index.snapshot
  const [lens, setLens] = useState<Lens>("usage")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [peekId, setPeekId] = useState<string | null>(null)
  const [runId, setRunIdState] = useState<string | null>(lastRunId)
  const setRunId = (id: string | null) => {
    lastRunId = id
    setRunIdState(id)
  }
  const [startError, setStartError] = useState<{ message: string; paused: boolean } | null>(null)
  const [asking, setAsking] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const guard = useRef(createLatestGuard())
  const question = useRun(runId)

  const ask = useCallback(
    async (text: string) => {
      const token = guard.current.begin()
      setAsking(true)
      setStartError(null)
      setRunId(null)
      try {
        const { run_id } = await api.startAnalysis({ intent: "question", question: text.slice(0, 200), snapshot_id: snapshot.snapshot_id })
        if (guard.current.isCurrent(token)) setRunId(run_id)
      } catch (err) {
        if (guard.current.isCurrent(token)) setStartError({ message: describeError(err, "The question could not be sent."), paused: isPause(err) })
      } finally {
        if (guard.current.isCurrent(token)) setAsking(false)
      }
    },
    [snapshot.snapshot_id],
  )

  // A question handed over from the map or the roadmap starts right away.
  useEffect(() => {
    const q = takePendingQuestion()
    if (q) void ask(q)
  }, [ask])

  const rows =
    hasVerifiedResult(question.run, snapshot.snapshot_id) && question.run?.result?.intent === "question" ? question.run.result.rows : null
  const highlight = useMemo(() => (rows ? highlightFromRows(rows.map((r) => r.id), snapshot.clusters) : NO_HIGHLIGHT), [rows, snapshot.clusters])

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
      {beat === 1 ? (
        <section aria-label="Architecture" className="min-h-0 overflow-y-auto">
          <div className="mx-auto max-w-[620px] py-2">
            <Architecture />
          </div>
        </section>
      ) : (
      <section aria-label="Usage map" className="relative min-h-[420px] overflow-hidden rounded-xl border bg-card">
        <UsageMap
          index={index}
          lens={lens}
          highlight={highlight}
          selectedId={selectedId}
          focusId={focusId}
          peekId={peekId}
          onSelectLeaf={setSelectedId}
          onFocusCategory={setFocusId}
          onLens={setLens}
        />
      </section>
      )}

      <aside aria-label={beat === 0 ? "Ask the agent" : "Containment"} className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        {beat === 0 ? (
          <>
            <Lead
              eyebrow="2 · Ask · the agent"
              title="Ask in plain English. The agent writes code, runs it in a sandbox, and shows only what the gate verifies."
              points={[
                "GLM 5.3 turns the question into a bounded plan, then writes program A (pandas) and program B (plain Python) without seeing a row",
                "Each program runs in its own throwaway gVisor container on the sandbox VM",
                "The gate checks both outputs and the published map, and A and B must agree. On failure the agent repairs once, visibly",
              ]}
            />
            <AnswerCard
              run={question.run}
              error={startError?.message ?? question.error}
              paused={!!startError?.paused}
              index={index}
              selectedId={selectedId}
              onSelectCluster={(id) => {
                if (focusId && index.byId.get(id)?.parent_id !== focusId) setFocusId(null)
                setSelectedId(id)
              }}
              onFocusCategory={(id) => {
                setSelectedId(null)
                setFocusId(id)
              }}
              onPeek={setPeekId}
              onOpenDetails={() => setSheetOpen(true)}
              onAsk={(q) => void ask(q)}
              onAskAnother={() => {
                setRunId(null)
                setStartError(null)
              }}
              asking={asking}
              onClose={() => {
                setRunId(null)
                setStartError(null)
                setPeekId(null)
              }}
            />
          </>
        ) : (
          <>
            <Lead
              eyebrow="2 · Ask · containment"
              title="Now try to break it. The sandbox has to absorb a runaway loop and rm -rf /, and the gate has to stop a leak."
              points={[]}
            />
            <Guarantees />
            <div className="rounded-xl border bg-card p-1">
              <Containment fill={false} />
            </div>
          </>
        )}
      </aside>

      <RunDetailsSheet open={sheetOpen} onOpenChange={setSheetOpen} run={question.run} snapshot={snapshot} />
    </div>
  )
}

const GUARANTEES = [
  { icon: Cpu, title: "Process isolation", body: "gVisor (runsc) user-space kernel, on a separate VM; never in the app process" },
  { icon: KeyRound, title: "Secret hygiene", body: "no API keys on the sandbox VM; --network=none; egress locked to the VPC" },
  { icon: Clock, title: "Resource limits", body: "10 s deadline enforced from outside, 512 MiB, 1 CPU, 64 pids, read-only root" },
  { icon: RotateCcw, title: "Lifecycle", body: "a fresh container per program, removal verified; the runner refuses work if it can't confirm" },
]

function Guarantees() {
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {GUARANTEES.map((g) => (
        <li key={g.title} className="rounded-xl border bg-card px-3.5 py-3">
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
            <g.icon aria-hidden className="size-3.5 text-ok" />
            {g.title}
          </div>
          <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{g.body}</p>
        </li>
      ))}
      <li className="flex items-start gap-1.5 px-1 text-[11.5px] leading-snug text-muted-foreground sm:col-span-2">
        <ShieldCheck aria-hidden className="mt-px size-3.5 shrink-0" />
        The programs below are fixed fixtures, submitted through the same runner, limits and gate as the agent's code.
      </li>
    </ul>
  )
}
