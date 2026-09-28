import { useState, type FormEvent } from "react"
import { ArrowRight, Check, ChevronDown, FileCode, LoaderCircle, MessageSquareText, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { QuestionResult, Run } from "@/lib/types"
import type { SnapshotIndex } from "@/lib/snapshot"
import { hasVerifiedResult, isRunActive, runDurationMs } from "@/lib/runs"
import { fillTemplate, resolvePath } from "@/lib/template"
import { fmtDuration, fmtInt, fmtPct } from "@/lib/format"
import { planShareNote, planToPhrases } from "@/lib/plan"
import { useGroupNames } from "@/hooks/useSubthemeRefs"
import { ASK_LABEL, ASK_SCOPE_NOTE, EXAMPLE_QUESTIONS } from "@/lib/copy"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AgentLoop } from "./AgentLoop"
import { Bar, Dot } from "./common"

type Props = {
  run: Run | null
  error: string | null
  /** the run could not start for a "try later" reason (budget, rate limit, capacity) */
  paused?: boolean
  index: SnapshotIndex
  selectedId: string | null
  onSelectCluster: (id: string) => void
  onFocusCategory: (id: string) => void
  onPeek: (id: string | null) => void
  onOpenDetails: () => void
  onClose: () => void
  /** question intent: submit a question (also used by example chips) */
  onAsk?: (question: string) => void
  /** question intent: clear the current question and show the ask form */
  onAskAnother?: () => void
  /** question intent: true while the POST is in flight */
  asking?: boolean
}

export function AnswerCard(props: Props) {
  const { run, error, paused, onClose } = props
  const [collapsed, setCollapsed] = useState(false)
  const unsupported = run?.state === "failed" && (run.error?.code === "unsupported_question" || run.error?.code === "interpretation_failed")
  const showForm = !run && !error && !props.asking
  const active = !showForm && !unsupported && (isRunActive(run) || (!run && !error))
  const done = run?.state === "completed"
  const verified = hasVerifiedResult(run, props.index.snapshot.snapshot_id)
  const failed = !unsupported && (run?.state === "failed" || (!!error && !run))
  const duration = runDurationMs(run)
  const title = run?.question ?? (showForm ? ASK_LABEL : "Your question")

  return (
    <section
      aria-labelledby="answer-h"
      aria-busy={active}
      className="shrink-0 overflow-hidden rounded-xl border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)]"
    >
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <MessageSquareText aria-hidden className="size-4 shrink-0 text-brand" />
        <h2 id="answer-h" className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={title}>
          {run?.question ? <span className="font-medium">“{run.question}”</span> : title}
        </h2>
        {showForm ? null : <StatusChip run={run} verified={verified} error={error} paused={!!paused} unsupported={unsupported} duration={duration} />}
        <Button variant="ghost" size="icon-xs" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? "Expand answer" : "Collapse answer"}>
          <ChevronDown className={cn("transition-transform duration-150", collapsed && "-rotate-90")} />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close answer">
          <X />
        </Button>
      </header>

      {!collapsed ? (
        <div className="flex flex-col gap-3 px-4 pt-3 pb-3">
          {showForm ? (
            <AskForm onAsk={props.onAsk} />
          ) : unsupported ? (
            <Unsupported
              reason={run?.error?.code === "interpretation_failed" ? "The question couldn't be interpreted this time. Try rephrasing it, or pick one of these." : (run?.error?.message ?? "")}
              title={run?.error?.code === "interpretation_failed" ? "Couldn't interpret that question" : undefined}
              onAsk={props.onAsk}
            />
          ) : (
            <>
              <AgentLoop run={run} />
              {run?.plan ? <PlanLine run={run} index={props.index} /> : null}
              {active ? <LiveLine run={run} asking={!!props.asking} /> : null}
              {error && run && !failed ? <p role="alert" className="text-[12.5px] text-destructive">{error}</p> : null}

              {failed ? (
                <div
                  role="alert"
                  className={cn(
                    "rounded-lg border px-3 py-2.5 text-[13px] leading-snug",
                    paused && !run ? "border-warn/30 bg-warn-soft" : "border-destructive/25 bg-destructive/5",
                  )}
                >
                  <p className={cn("font-medium", paused && !run ? "text-foreground/85" : "text-destructive")}>
                    {run?.error?.message ?? error ?? "The analysis failed."}
                  </p>
                  {run?.verdict && !run.verdict.passed ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      Failed gate checks: {run.verdict.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}. Nothing from the program's output reached this page.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {verified && run?.result ? (
                <>
                  <Explanation run={run} index={props.index} onSelect={props.onSelectCluster} onFocusCategory={props.onFocusCategory} />
                  {run.result.intent === "question" ? <QuestionRanking result={run.result} {...props} /> : null}
                </>
              ) : done ? (
                <p className="text-[13px] text-muted-foreground">The run completed without a verified result for this snapshot. Ask again to use the current map.</p>
              ) : active ? (
                <div className="flex flex-col gap-2" aria-hidden>
                  <Skeleton className="h-3.5 w-11/12" />
                  <Skeleton className="h-3.5 w-9/12" />
                  <Skeleton className="mt-1.5 h-3 w-full" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-10/12" />
                </div>
              ) : null}
            </>
          )}

          {showForm ? null : (
            <footer className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-2.5 text-[11.5px] text-muted-foreground">
              {run ? (
                <span className="font-mono">
                  {run.run_id}
                  {run.verdict && !unsupported ? ` · gate ${run.verdict.checks.filter((c) => c.passed).length}/${run.verdict.checks.length}` : ""}
                  {run.attempts ? ` · ${run.attempts} sandbox ${run.attempts === 1 ? "run" : "runs"}` : ""}
                </span>
              ) : (
                <span>{failed ? "No run was started" : "Starting…"}</span>
              )}
              <span className="ml-auto flex items-center gap-1">
                {(done || failed || unsupported || error) && props.onAskAnother ? (
                  <Button variant="ghost" size="xs" onClick={props.onAskAnother}>
                    <MessageSquareText />
                    Ask another
                  </Button>
                ) : null}

                <Button variant="outline" size="xs" onClick={props.onOpenDetails} disabled={!run || unsupported}>
                  <FileCode />
                  Run details
                </Button>
              </span>
            </footer>
          )}
        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------- ask

function AskForm({ onAsk, initial = "" }: { onAsk?: (q: string) => void; initial?: string }) {
  const [text, setText] = useState(initial)
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const q = text.trim()
    if (q && onAsk) onAsk(q)
  }
  return (
    <div className="flex flex-col gap-2.5">
      <form onSubmit={submit} className="flex items-center gap-2">
        <label htmlFor="ask-input" className="sr-only">
          Your question about workflows, people or friction
        </label>
        <input
          id="ask-input"
          autoFocus
          value={text}
          maxLength={200}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask about workflows, people or friction…"
          className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-card px-3 text-[13.5px] shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
        />
        <Button type="submit" size="icon" className="size-9" disabled={!text.trim()} aria-label="Ask">
          <ArrowRight />
        </Button>
      </form>
      <ExampleChips onAsk={onAsk} />
      <p className="text-[11.5px] leading-snug text-muted-foreground">{ASK_SCOPE_NOTE}</p>
    </div>
  )
}

function ExampleChips({ onAsk, label = "Try" }: { onAsk?: (q: string) => void; label?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium tracking-[0.05em] text-muted-foreground uppercase">{label}</span>
      <ul className="flex flex-col gap-1">
        {EXAMPLE_QUESTIONS.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onAsk?.(q)}
              className="w-full rounded-lg border bg-muted/40 px-2.5 py-1.5 text-left text-[12.5px] leading-snug transition-colors hover:border-foreground/20 hover:bg-muted"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Unsupported({ reason, title, onAsk }: { reason: string; title?: string; onAsk?: (q: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div role="status" className="rounded-lg border border-dashed px-3 py-2.5">
        <p className="text-[13px] font-medium">{title ?? "That isn't answerable from this snapshot"}</p>
        {reason ? <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{reason}</p> : null}
      </div>
      <ExampleChips onAsk={onAsk} label="Try one of these" />
    </div>
  )
}

function PlanLine({ run, index }: { run: Run; index: SnapshotIndex }) {
  const plan = run.plan!
  const titleOf = useGroupNames(index).nameOf
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-2">
      <div className="text-[10.5px] font-medium tracking-[0.06em] text-muted-foreground uppercase">Interpreted as</div>
      <p className="mt-0.5 text-[13px] leading-snug font-medium">
        {planToPhrases(plan, titleOf).map((p, i) => (
          <span key={i}>
            {i > 0 ? <span className="px-1 text-subtle">·</span> : null}
            {p}
          </span>
        ))}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- shared

function StatusChip({
  run,
  verified,
  error,
  paused,
  unsupported,
  duration,
}: {
  run: Run | null
  verified: boolean
  error: string | null
  paused: boolean
  unsupported: boolean
  duration: number | null
}) {
  if (verified) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-[11.5px] font-medium text-ok">
        <Check aria-hidden className="size-3" />
        Verified · {fmtDuration(duration)}
      </span>
    )
  }
  if (run?.state === "completed") return <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[11.5px] font-medium text-warn">Unverified</span>
  if (unsupported) {
    return <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">Not answerable</span>
  }
  if (error && !run && paused) {
    return <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[11.5px] font-medium text-warn">Paused</span>
  }
  if (run?.state === "failed" || (error && !run)) {
    return <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11.5px] font-medium text-destructive">Failed</span>
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[11.5px] font-medium text-brand">
      <LoaderCircle aria-hidden className="size-3 animate-spin" />
      Running
    </span>
  )
}

function LiveLine({ run, asking }: { run: Run | null; asking: boolean }) {
  const stage = run?.stages.find((s) => s.status === "running")
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
      <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin text-brand" />
      {stage?.detail ?? (run ? "Queued" : asking ? "Sending the question…" : "Starting the run…")}
    </p>
  )
}

function Explanation({
  run,
  index,
  onSelect,
  onFocusCategory,
}: {
  run: Run
  index: SnapshotIndex
  onSelect: (id: string) => void
  onFocusCategory: (id: string) => void
}) {
  const names = useGroupNames(index)
  if (!run.explanation) {
    return <p className="text-[13px] text-muted-foreground">No explanation was published for this run; the ranking below comes straight from the validated result.</p>
  }
  const segs = fillTemplate(run.explanation.text, run.result, names.titleOf)
  const open = (raw: unknown) => {
    if (typeof raw !== "string") return
    const id = names.subtheme(raw)?.leafId ?? raw // a sub-theme opens its workflow
    if (!index.byId.has(id)) return
    if (index.byId.get(id)!.level === 1) onFocusCategory(id)
    else onSelect(id)
  }
  return (
    <p className="text-[13.5px] leading-[1.6] text-pretty text-foreground/90">
      {segs.map((s, i) =>
        s.kind === "text" ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === "metric" ? (
          /(^|\.)(cluster_id|category_id|id)$/.test(s.key) ? (
            <button
              key={i}
              type="button"
              data-metric={s.key}
              onClick={() => open(resolvePath(run.result, s.key))}
              className="rounded-sm font-medium text-foreground underline decoration-foreground/20 underline-offset-[3px] transition-colors hover:decoration-foreground/60"
            >
              {s.text}
            </button>
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

function QuestionRanking({
  result,
  index,
  selectedId,
  onSelectCluster,
  onFocusCategory,
  onPeek,
}: { result: QuestionResult } & Pick<Props, "index" | "selectedId" | "onSelectCluster" | "onFocusCategory" | "onPeek">) {
  const names = useGroupNames(index)
  const plan = result.plan
  const byShare = plan.rank_by === "share"
  const max = Math.max(byShare ? 0.0001 : 1, ...result.rows.map((r) => (byShare ? r.share : r.count)))
  const unit = plan.measure === "people" ? "people" : "conversations"
  if (!result.rows.length) return <p className="text-[13px] text-muted-foreground">No group in this scope matched the plan.</p>
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px] font-medium tracking-[0.05em] text-muted-foreground uppercase">
        <span>
          Verified rows · {byShare ? "by share" : "by count"}
        </span>
        <span className="tracking-normal normal-case">
          {unit}: count of base · share
        </span>
      </div>
      <ol className="flex flex-col">
        {result.rows.map((r, i) => {
          const sub = names.subtheme(r.id)
          const target = sub?.leafId ?? r.id // a sub-theme row selects its workflow
          const node = index.byId.get(target)
          const isCat = node?.level === 1
          const pal = names.paletteOf(r.id)
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => (isCat ? onFocusCategory(target) : onSelectCluster(target))}
                onMouseEnter={() => !isCat && onPeek(target)}
                onMouseLeave={() => onPeek(null)}
                onFocus={() => !isCat && onPeek(target)}
                onBlur={() => onPeek(null)}
                aria-current={selectedId === r.id ? "true" : undefined}
                className={cn(
                  "grid w-full grid-cols-[1.1rem_1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted",
                  selectedId === r.id && "bg-muted",
                )}
              >
                <span className="font-mono text-[11px] text-subtle tabular-nums">{i + 1}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
                  <Dot color={pal.dot} />
                  <span className="truncate">{sub?.name ?? node?.title ?? r.id}</span>
                </span>
                <span className="font-mono text-[12px] tabular-nums">
                  <span className={cn(!byShare && "font-medium")}>{fmtInt(r.count)}</span>
                  <span className="text-muted-foreground"> of {fmtInt(r.base)} · </span>
                  <span className={cn(byShare && "font-medium")}>{fmtPct(r.share)}</span>
                </span>
                <span />
                <Bar value={byShare ? r.share : r.count} max={max} className="col-span-2 h-1" hatched={!!plan.signal} fillClassName={plan.signal ? "bg-heat/35" : "bg-foreground/35"} />
              </button>
            </li>
          )
        })}
      </ol>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        Whole scope: {fmtInt(result.total_count)} of {fmtInt(result.total_base)} {unit} ({fmtPct(result.total_base ? result.total_count / result.total_base : null)}). {planShareNote(plan)} Other or unclear is excluded.
      </p>
    </div>
  )
}
