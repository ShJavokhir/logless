import { Check, ChevronDown, CircleAlert, FileCode, LoaderCircle, RotateCcw, Users, X } from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"
import type { FrictionRow, Intent, Run, UsageRow } from "@/lib/types"
import type { SnapshotIndex } from "@/lib/snapshot"
import { deriveSteps, isRunActive, runDurationMs, type Step } from "@/lib/runs"
import { fillTemplate, resolvePath } from "@/lib/template"
import { fmtDuration, fmtInt, fmtPct } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Bar, Dot } from "./common"
import { QUESTION } from "@/lib/copy"

type Props = {
  intent: Intent
  run: Run | null
  error: string | null
  index: SnapshotIndex
  selectedId: string | null
  onSelectCluster: (id: string) => void
  onPeek: (id: string | null) => void
  onOpenDetails: () => void
  onRunAgain: () => void
  onClose: () => void
}

export function AnswerCard({ intent, run, error, index, selectedId, onSelectCluster, onPeek, onOpenDetails, onRunAgain, onClose }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const active = isRunActive(run) || (!run && !error)
  const steps = deriveSteps(run)
  const done = run?.state === "completed"
  const failed = run?.state === "failed" || (!!error && !run)
  const duration = runDurationMs(run)
  const Icon = intent === "usage" ? Users : CircleAlert

  return (
    <section
      aria-labelledby="answer-h"
      aria-busy={active}
      className="shrink-0 overflow-hidden rounded-xl border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)]"
    >
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <Icon aria-hidden className={cn("size-4 shrink-0", intent === "friction" ? "text-heat" : "text-brand")} />
        <h2 id="answer-h" className="min-w-0 flex-1 truncate text-[14px] font-semibold">
          {QUESTION[intent]}
        </h2>
        <StatusChip run={run} error={error} duration={duration} />
        <Button variant="ghost" size="icon-xs" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? "Expand answer" : "Collapse answer"}>
          <ChevronDown className={cn("transition-transform duration-150", collapsed && "-rotate-90")} />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close answer">
          <X />
        </Button>
      </header>

      {!collapsed ? (
        <div className="flex flex-col gap-3 px-4 pt-3 pb-3">
          <Stepper steps={steps} attempts={run?.attempts ?? 0} />

          {active ? <LiveLine run={run} /> : null}

          {failed ? (
            <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-[13px] leading-snug">
              <p className="font-medium text-destructive">{run?.error?.message ?? error ?? "The analysis failed."}</p>
              {run?.verdict && !run.verdict.passed ? (
                <p className="mt-1 text-[12px] text-muted-foreground">
                  Failed gate checks: {run.verdict.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}. Nothing from the program's output reached this page.
                </p>
              ) : null}
            </div>
          ) : null}

          {done && run?.result ? (
            <>
              <Explanation run={run} index={index} onSelect={onSelectCluster} />
              <Ranking run={run} index={index} selectedId={selectedId} onSelect={onSelectCluster} onPeek={onPeek} />
            </>
          ) : done ? (
            <p className="text-[13px] text-muted-foreground">The run completed without a publishable result.</p>
          ) : active ? (
            <div className="flex flex-col gap-2" aria-hidden>
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-9/12" />
              <Skeleton className="mt-1.5 h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-10/12" />
            </div>
          ) : null}

          <footer className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-2.5 text-[11.5px] text-muted-foreground">
            {run ? (
              <span className="font-mono">
                {run.run_id}
                {run.verdict ? ` · gate ${run.verdict.checks.filter((c) => c.passed).length}/${run.verdict.checks.length}` : ""}
                {run.attempts ? ` · ${run.attempts} ${run.attempts === 1 ? "attempt" : "attempts"}` : ""}
              </span>
            ) : (
              <span>{failed ? "No run was started" : "Starting…"}</span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {done || failed ? (
                <Button variant="ghost" size="xs" onClick={onRunAgain}>
                  <RotateCcw />
                  Run again
                </Button>
              ) : null}
              <Button variant="outline" size="xs" onClick={onOpenDetails} disabled={!run}>
                <FileCode />
                Run details
              </Button>
            </span>
          </footer>
        </div>
      ) : null}
    </section>
  )
}

function StatusChip({ run, error, duration }: { run: Run | null; error: string | null; duration: number | null }) {
  if (run?.state === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-[11.5px] font-medium text-ok">
        <Check aria-hidden className="size-3" />
        Verified · {fmtDuration(duration)}
      </span>
    )
  }
  if (run?.state === "failed" || (error && !run)) {
    return <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11.5px] font-medium text-destructive">Failed</span>
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[11.5px] font-medium text-brand">
      <LoaderCircle aria-hidden className="size-3 animate-spin" />
      Running
    </span>
  )
}

function Stepper({ steps, attempts }: { steps: Step[]; attempts: number }) {
  return (
    <ol className="flex items-start gap-1" aria-label="Run progress">
      {steps.map((s, i) => (
        <li key={s.key} className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-1">
            <StepDot status={s.status} />
            {i < steps.length - 1 ? (
              <span aria-hidden className={cn("h-px flex-1 transition-colors duration-200", s.status === "done" ? "bg-foreground/40" : "bg-border")} />
            ) : null}
          </div>
          <span
            className={cn(
              "pr-1 text-[11.5px] leading-tight text-balance",
              s.status === "running" ? "font-medium text-foreground" : s.status === "pending" || s.status === "skipped" ? "text-subtle" : "text-muted-foreground",
              s.status === "failed" && "text-destructive",
            )}
          >
            {s.label}
            {s.key === "executing" && attempts >= 2 ? <span className="font-mono"> ×{attempts}</span> : null}
            <span className="sr-only"> — {s.status}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function StepDot({ status }: { status: Step["status"] }) {
  if (status === "done")
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-foreground text-background">
        <Check aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    )
  if (status === "running")
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-brand-soft ring-1 ring-brand/50">
        <span className="size-1.5 animate-pulse rounded-full bg-brand" />
      </span>
    )
  if (status === "failed")
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-destructive text-white">
        <X aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    )
  return <span className="size-4 shrink-0 rounded-full border border-dashed border-subtle/60" />
}

function LiveLine({ run }: { run: Run | null }) {
  const stage = run?.stages.find((s) => s.status === "running")
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
      <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin text-brand" />
      {stage?.detail ?? (run ? "Queued" : "Starting the run…")}
    </p>
  )
}

function Explanation({ run, index, onSelect }: { run: Run; index: SnapshotIndex; onSelect: (id: string) => void }) {
  if (!run.explanation) {
    return <p className="text-[13px] text-muted-foreground">No explanation was published for this run; the ranking below comes straight from the validated result.</p>
  }
  const segs = fillTemplate(run.explanation.text, run.result, index.titleOf)
  return (
    <p className="text-[13.5px] leading-[1.6] text-pretty text-foreground/90">
      {segs.map((s, i) =>
        s.kind === "text" ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === "metric" ? (
          /(^|\.)cluster_id$/.test(s.key) ? (
            <button
              key={i}
              type="button"
              data-metric={s.key}
              onClick={() => {
                const id = resolvePath(run.result, s.key)
                if (typeof id === "string" && index.byId.has(id)) onSelect(id)
              }}
              className="rounded-sm font-medium text-foreground underline decoration-foreground/20 underline-offset-[3px] transition-colors hover:decoration-foreground/60"
            >
              {s.text}
            </button>
          ) : /(^|\.)category_id$/.test(s.key) ? (
            <span key={i} className="font-medium text-foreground" data-metric={s.key}>
              {s.text}
            </span>
          ) : (
            <span key={i} title={`From the validated result: ${s.key}`} data-metric={s.key} className="rounded-[3px] bg-brand-soft px-[2px] font-mono text-[13px] font-medium text-foreground tabular-nums">
              {s.text}
            </span>
          )
        ) : (
          <span key={i} title={`Placeholder ${s.key} is not in the validated result, so no number is shown.`} className="rounded-[3px] border border-dashed px-[2px] text-muted-foreground italic">
            unavailable
          </span>
        ),
      )}
    </p>
  )
}

function Ranking({
  run,
  index,
  selectedId,
  onSelect,
  onPeek,
}: {
  run: Run
  index: SnapshotIndex
  selectedId: string | null
  onSelect: (id: string) => void
  onPeek: (id: string | null) => void
}) {
  const result = run.result!
  const rows = result.rows.slice(0, 5)
  const friction = result.intent === "friction"
  const max = Math.max(1, ...rows.map((r) => (friction ? (r as FrictionRow).friction_conversations : (r as UsageRow).conversations)))
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px] font-medium tracking-[0.05em] text-muted-foreground uppercase">
        <span>Top 5 {friction ? "by conversations with friction" : "by conversations"}</span>
        <span className="normal-case tracking-normal">{friction ? "of cluster total · rate" : `of ${fmtInt(result.total_conversations)} · people`}</span>
      </div>
      <ol className="flex flex-col">
        {rows.map((r, i) => {
          const title = index.titleOf(r.cluster_id) ?? r.cluster_id
          const pal = index.paletteOf(r.cluster_id)
          const fr = r as FrictionRow
          const us = r as UsageRow
          const value = friction ? fr.friction_conversations : us.conversations
          return (
            <li key={r.cluster_id}>
              <button
                type="button"
                onClick={() => onSelect(r.cluster_id)}
                onMouseEnter={() => onPeek(r.cluster_id)}
                onMouseLeave={() => onPeek(null)}
                onFocus={() => onPeek(r.cluster_id)}
                onBlur={() => onPeek(null)}
                aria-current={selectedId === r.cluster_id ? "true" : undefined}
                className={cn(
                  "grid w-full grid-cols-[1.1rem_1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted",
                  selectedId === r.cluster_id && "bg-muted",
                )}
              >
                <span className="font-mono text-[11px] text-subtle tabular-nums">{i + 1}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
                  <Dot color={pal.dot} />
                  <span className="truncate">{title}</span>
                </span>
                <span className="font-mono text-[12px] tabular-nums">
                  {friction ? (
                    <>
                      {fmtInt(fr.friction_conversations)}
                      <span className="text-muted-foreground"> of {fmtInt(fr.conversations)} · </span>
                      <span className="font-medium">{fmtPct(fr.friction_share)}</span>
                    </>
                  ) : (
                    <>
                      {fmtInt(us.conversations)}
                      <span className="text-muted-foreground"> · {fmtPct(us.share)} · </span>
                      <span className={cn(us.users * 3 <= us.conversations && "font-medium text-brand")}>{fmtInt(us.users)} ppl</span>
                    </>
                  )}
                </span>
                <span />
                <Bar value={value} max={max} className="col-span-2 h-1" hatched={friction} fillClassName={friction ? "bg-heat/35" : "bg-foreground/35"} />
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
