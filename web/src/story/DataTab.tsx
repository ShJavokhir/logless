import { useEffect, useState } from "react"
import { ArrowUpRight, RotateCcw } from "lucide-react"
import type { useIntake } from "@/hooks/useIntake"
import type { SnapshotIndex } from "@/lib/snapshot"
import { orderedLanguages } from "@/lib/snapshot"
import { fmtDateRange, fmtInt } from "@/lib/format"
import { fixtureCount } from "@/lib/copy"
import { NO_HIGHLIGHT } from "@/lib/search"
import { Button } from "@/components/ui/button"
import { MarbleMachine } from "@/components/MarbleMachine"
import { IntakeFlow } from "@/components/IntakeFlow"
import { UsageMap, type Lens } from "@/components/UsageMap"

type Intake = ReturnType<typeof useIntake>

export function DataTab({ index, intake, active }: { index: SnapshotIndex; intake: Intake; active: boolean }) {
  const wide = useWide()
  const ready = !!intake.status?.ready
  // The marble machine needs a presenter key and a prepared batch; everyone sees the classified map below it.
  // It always comes up armed: a batch that was already sorted is reset first, then sorted again.
  const hasBatch = (intake.status?.batch_size ?? 0) > 0
  const marbles = wide && intake.presenter && (intake.phase !== "idle" || hasBatch)
  const armed = active && intake.phase === "idle" && hasBatch
  const sort = async () => {
    if (!ready) await intake.reset()
    await intake.start()
  }
  const action =
    intake.phase === "failed" ? (
      <>
        <span className="max-w-[260px] truncate text-[12px] text-destructive" title={intake.error ?? undefined}>
          {intake.error ?? "The intake failed."}
        </span>
        <Button size="sm" variant="outline" onClick={intake.close}>
          Close
        </Button>
      </>
    ) : intake.published ? (
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void intake.reset()}>
        <RotateCcw />
        Reset
      </Button>
    ) : null

  return (
    // A centred column: edge-to-edge on a wide monitor is hard to read.
    <div className="h-full overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto flex min-h-full w-full max-w-[1200px] flex-col gap-3">
        <DatasetCard index={index} />
        {/* The live intake sits above the map; the map stays, and grows when a run publishes. */}
        {marbles || intake.flowVisible ? (
          <section aria-label="Live intake" className="relative h-[620px] shrink-0 overflow-hidden rounded-xl border bg-card">
            {marbles ? (
              <MarbleMachine key={intake.runId ?? "ready"} intake={intake} index={index} armed={armed} onSort={() => void sort()} action={action} />
            ) : (
              <IntakeFlow intake={intake} index={index} />
            )}
          </section>
        ) : null}
        <section aria-label="Classification" className="relative h-[680px] shrink-0 overflow-hidden rounded-xl border bg-card">
          <ClassifiedMap index={index} />
        </section>
      </div>
    </div>
  )
}

function DatasetCard({ index }: { index: SnapshotIndex }) {
  const { dataset: d, totals } = index.snapshot
  const fixtures = fixtureCount(d.fixtures)
  const workflows = index.snapshot.clusters.filter((c) => !c.is_other && c.id !== "cl_other").length
  const categories = index.categories.filter((c) => !c.is_other).length
  const langs = orderedLanguages(totals.languages)
  const langTotal = langs.reduce((a, l) => a + l.conversations, 0) || 1
  return (
    <section aria-labelledby="dataset-h" className="shrink-0 rounded-xl border bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4">
        <div className="max-w-[440px] min-w-[240px] flex-1">
          <h1 id="dataset-h" className="flex items-center gap-2 text-[20px] font-semibold tracking-tight">
            {d.name}
            <a
              href={d.source_url}
              target="_blank"
              rel="noreferrer"
              aria-label={`${d.name} source`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowUpRight className="size-4" />
            </a>
          </h1>
          <p className="mt-1 text-[13.5px] leading-snug text-pretty text-muted-foreground">{index.snapshot.workspace.description}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-5">
          <Stat label="Conversations" value={fmtInt(totals.conversations)} sub={fixtures ? `incl. ${fmtInt(fixtures)} test fixtures` : undefined} />
          <Stat label="People" value={fmtInt(totals.users)} />
          <Stat label="Languages" value={fmtInt(d.languages)} />
          <Stat label="Workflows" value={fmtInt(workflows)} sub={`in ${categories} categories`} />
          <Stat label="Period" value={fmtDateRange(d.period_start, d.period_end)} small />
        </dl>
      </div>
      {langs.length ? (
        <div className="mt-4">
          <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
            {langs.map((l, i) => (
              <span key={l.name} className="h-full border-r-2 border-card last:border-r-0" style={{ width: `${(l.conversations / langTotal) * 100}%`, background: `oklch(${0.45 + i * 0.09} 0.03 260)` }} />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            {langs.map((l, i) => (
              <li key={l.name} className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-full" style={{ background: `oklch(${0.45 + i * 0.09} 0.03 260)` }} />
                {l.name}
                <span className="font-mono tabular-nums">{fmtInt(l.conversations)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function Stat({ label, value, sub, small }: { label: string; value: string; sub?: string; small?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className={small ? "mt-1 text-[14px] leading-tight font-semibold" : "font-mono text-[22px] leading-tight font-semibold tabular-nums"}>{value}</dd>
      {sub ? <dd className="text-[11.5px] text-muted-foreground">{sub}</dd> : null}
    </div>
  )
}

function ClassifiedMap({ index }: { index: SnapshotIndex }) {
  const [lens, setLens] = useState<Lens>("usage")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  return (
    <UsageMap
      index={index}
      lens={lens}
      highlight={NO_HIGHLIGHT}
      selectedId={selectedId}
      focusId={focusId}
      peekId={null}
      onSelectLeaf={setSelectedId}
      onFocusCategory={setFocusId}
      onLens={setLens}
    />
  )
}

function useWide() {
  const query = "(min-width: 1024px)"
  const [wide, setWide] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const on = () => setWide(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return wide
}
