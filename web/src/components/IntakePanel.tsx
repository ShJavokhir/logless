import { Check, Info, LoaderCircle, Radio, RotateCcw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { useIntake } from "@/hooks/useIntake"
import type { SnapshotIndex } from "@/lib/snapshot"
import { INTAKE_STAGES, formatDelta, observedSignals, stageStates, type StageState } from "@/lib/intake"
import { proseName } from "@/lib/labels"
import { fmtInt } from "@/lib/format"
import { signalName } from "@/lib/colors"
import type { Signal } from "@/lib/types"
import { INTAKE_COPY } from "@/lib/copy"
import { Button } from "@/components/ui/button"
import { Dot, Hint, SignalIcon } from "./common"

type Intake = ReturnType<typeof useIntake>

const VISIBLE = 8

export function IntakePanel({ intake, index }: { intake: Intake; index: SnapshotIndex }) {
  const { phase, counters, stage, runState, feed, summary, published, error } = intake
  const states = stageStates(stage, runState)
  const running = phase === "running" || phase === "starting"
  const total = counters?.total ?? intake.status?.batch_size ?? 0
  const decided = counters?.decided ?? 0
  const nameOf = (id: string) => {
    const n = index.byId.get(id)
    return n ? proseName(n) : undefined
  }

  return (
    <section aria-labelledby="intake-h" className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex items-center gap-2">
        <Radio aria-hidden className={cn("size-4 shrink-0", running ? "text-brand" : "text-muted-foreground")} />
        <h2 id="intake-h" className="flex-1 text-[15px] font-semibold">
          Live intake
        </h2>
        {running ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[11.5px] font-medium text-brand">
            <span className="size-1.5 animate-pulse rounded-full bg-brand" />
            Live
          </span>
        ) : phase === "failed" ? (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11.5px] font-medium text-destructive">Failed</span>
        ) : published ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-[11.5px] font-medium text-ok">
            <Check aria-hidden className="size-3" />
            Published
          </span>
        ) : null}
        {!running ? (
          <Button variant="ghost" size="icon-xs" onClick={intake.close} aria-label="Close live intake">
            <X />
          </Button>
        ) : null}
      </header>

      <p className="flex items-start gap-1.5 text-[12px] leading-snug text-muted-foreground">
        <span>Read earlier by GLM on Vultr · decided live by Jev · filed into the published map</span>
        <Hint label={INTAKE_COPY}>
          <button type="button" className="mt-px rounded-full" aria-label="About live intake">
            <Info className="size-3.5" />
          </button>
        </Hint>
      </p>

      {/* stages */}
      <ol className="flex items-start gap-1" aria-label="Intake stages">
        {INTAKE_STAGES.map((s, i) => (
          <li key={s.key} className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-1">
              <StageDot state={states[i]} />
              {i < INTAKE_STAGES.length - 1 ? <span aria-hidden className={cn("h-px flex-1", states[i] === "done" ? "bg-foreground/40" : "bg-border")} /> : null}
            </div>
            <span
              className={cn(
                "pr-1 text-[11.5px] leading-tight text-balance",
                states[i] === "running" ? "font-medium text-foreground" : states[i] === "pending" ? "text-subtle" : "text-muted-foreground",
                states[i] === "failed" && "text-destructive",
              )}
            >
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      {/* counters */}
      <div className="rounded-xl border bg-muted/40 p-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[22px] leading-none font-medium tabular-nums">
            {fmtInt(decided)}
            <span className="text-[14px] text-muted-foreground"> / {fmtInt(total)}</span>
          </span>
          <span className="text-[12px] text-muted-foreground">conversations decided</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-faint" aria-hidden>
          <div className="h-full rounded-full bg-brand transition-[width] duration-300 ease-out" style={{ width: `${total ? (decided / total) * 100 : 0}%` }} />
        </div>
        <dl className="mt-2.5 grid grid-cols-3 gap-2 text-[11.5px]">
          <Counter label="per second" value={counters ? counters.per_second.toFixed(0) : "—"} unit="conv/s" />
          <Counter label="per Jev call" value={counters ? fmtInt(counters.p50_ms) : "—"} unit="ms p50" />
          <Counter label="per conversation" value={counters ? String(counters.decisions_per_conversation) : "—"} unit="decisions" />
        </dl>
      </div>

      {/* completion */}
      {published && summary ? (
        <div className="rounded-xl border border-ok/25 bg-ok-soft/60 p-3.5 text-[12.5px]">
          <p className="font-medium">
            Map updated · +{fmtInt(summary.decided)} conversations
            <span className="font-normal text-muted-foreground">
              {" "}
              ({fmtInt(summary.other)} to Other or unclear)
            </span>
          </p>
          <ul className="mt-1.5 flex flex-col gap-0.5 text-muted-foreground">
            {summary.deltas
              .filter((d) => d.id.startsWith("cl_") && d.id !== "cl_other")
              .slice(0, 4)
              .map((d) => (
                <li key={d.id} className="truncate">
                  {formatDelta(d, nameOf)}
                </li>
              ))}
          </ul>
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{summary.published_snapshot_id}</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}

      {/* live feed */}
      <div className="min-h-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]">
        <div className="mb-1.5 flex items-baseline justify-between text-[11px] font-medium tracking-[0.05em] text-muted-foreground uppercase">
          <span>Decisions</span>
          <span className="tracking-normal normal-case">newest first · sampled</span>
        </div>
        <ol className="flex flex-col" aria-live="off">
          {feed.slice(0, VISIBLE).map((ev, i) => {
            const leaf = index.byId.get(ev.leaf_id)
            const pal = index.paletteOf(ev.leaf_id)
            const sigs = observedSignals(ev) as Signal[]
            return (
              <li
                key={ev.seq}
                className="animate-in border-b border-border/60 py-1.5 duration-300 fade-in-0 slide-in-from-top-1 last:border-b-0"
                style={{ opacity: Math.max(0.28, 1 - i * 0.1) }}
              >
                <p className={cn("truncate text-[12.5px] leading-snug", !ev.summary && "text-subtle italic")}>{ev.summary ?? "summary withheld"}</p>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex min-w-0 items-center gap-1 rounded-full border bg-card px-1.5 py-px text-foreground">
                    <Dot color={pal.dot} className="size-1.5" />
                    <span className="truncate">{leaf ? (leaf.short_title ?? leaf.title) : ev.leaf_id}</span>
                  </span>
                  <span className="font-mono tabular-nums">Jev {ev.p.toFixed(2)}</span>
                  {sigs.map((sg) => (
                    <span key={sg} title={signalName(sg)} className="inline-flex">
                      <SignalIcon signal={sg} className="size-3 text-heat" />
                      <span className="sr-only">{signalName(sg)}</span>
                    </span>
                  ))}
                  <span className="ml-auto shrink-0">
                    {ev.language} · {ev.turns} {ev.turns === 1 ? "turn" : "turns"}
                  </span>
                </div>
              </li>
            )
          })}
          {!feed.length ? <li className="py-2 text-[12.5px] text-muted-foreground">{running ? "Waiting for the first decision…" : "No decisions yet."}</li> : null}
        </ol>
      </div>

      <footer className="flex items-center gap-2 border-t pt-2.5 text-[11.5px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {running ? "Classifying new conversations…" : published ? "The key finding and map now include this batch." : "Presenter-only"}
        </span>
        {intake.presenter && !running ? (
          <Button variant="ghost" size="xs" onClick={() => void intake.reset()}>
            <RotateCcw />
            Reset intake
          </Button>
        ) : null}
      </footer>
    </section>
  )
}

function Counter({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="min-w-0">
      <dt className="sr-only">{label}</dt>
      <dd className="truncate">
        <span className="font-mono text-[13px] font-medium text-foreground tabular-nums">{value}</span> <span>{unit}</span>
      </dd>
      <span className="text-subtle">{label}</span>
    </div>
  )
}

function StageDot({ state }: { state: StageState }) {
  if (state === "done")
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-foreground text-background">
        <Check aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    )
  if (state === "running")
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-brand-soft ring-1 ring-brand/50">
        <LoaderCircle aria-hidden className="size-2.5 animate-spin text-brand" />
      </span>
    )
  if (state === "failed")
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-destructive text-white">
        <X aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    )
  return <span className="size-4 shrink-0 rounded-full border border-dashed border-subtle/60" />
}
