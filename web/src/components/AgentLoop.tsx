import { Check, CornerDownRight, RotateCcw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Run, StageStatus } from "@/lib/types"
import { deriveSteps, type StepStatus } from "@/lib/runs"
import { fmtMs } from "@/lib/format"
import { crossChecks, isTwoProgram, missingReceiptCopy, PROGRAM_KIND, programGateTally, programTracks, repairs } from "@/lib/programs"

type LoopStep = { key: string; label: string; status: StepStatus; values: string[] }

/**
 * The agent loop with real values only (§0): interpreted → wrote programs →
 * ran in gVisor → gate + published map → programs agree → explained.
 */
export function AgentLoop({ run, forQuestion = true }: { run: Run | null; forQuestion?: boolean }) {
  const steps = deriveSteps(run, forQuestion)
  const status = (key: string): StepStatus => steps.find((s) => s.key === key)?.status ?? "pending"
  const tracks = programTracks(run)
  const two = isTwoProgram(run) || (tracks.length === 0 && forQuestion)
  const cross = crossChecks(run)
  const tally = programGateTally(run)
  const done = (s: StepStatus) => s === "done" || s === "failed"

  const planning = status("planning")
  const executing = status("executing")
  const validating = status("validating")
  const explaining = status("explaining")

  const shaLines = tracks.map((t) => `${t.program} ${t.latest.code_sha256.slice(0, 8)}`)
  const timeLines = tracks.map((t) => `${t.program} ${t.latest.receipt ? fmtMs(t.latest.receipt.elapsed_ms) : missingReceiptCopy(t.latest).label}`)
  const receipts = tracks.flatMap((t) => t.latest.receipt ? [t.latest.receipt] : [])
  const runtime = receipts.length && receipts.every((r) => r.runtime === "runsc") ? "gVisor" : "sandbox"
  const gateLines: string[] = []
  if (tally) gateLines.push(`${tally.passed}/${tally.total}${tally.passed === tally.total ? "" : " ✕"}`)
  else if (run?.verdict) gateLines.push(`${run.verdict.checks.filter((c) => c.passed).length}/${run.verdict.checks.length}`)
  if (two && (tally || run?.verdict) && done(validating)) {
    const c = cross.consistency
    gateLines.push(c.length ? `map ${c.filter((x) => x.passed).length}/${c.length}` : "map n/a")
  }

  let agree: StepStatus = "pending"
  if (cross.agreement) agree = cross.agreement.passed ? "done" : "failed"
  else if (run?.state === "failed") agree = "skipped"
  else if (run?.state === "completed") agree = "skipped"

  const loop: LoopStep[] = [
    ...(steps.some((s) => s.key === "interpreting")
      ? [{ key: "interpreting", label: status("interpreting") === "failed" ? "Interpretation failed" : done(status("interpreting")) ? "Interpreted" : "Interpreting", status: status("interpreting"), values: status("interpreting") === "done" ? ["plan ready"] : status("interpreting") === "failed" ? ["no plan"] : [] }]
      : []),
    {
      key: "planning",
      label: planning === "failed" ? "Writing failed" : done(planning) ? (tracks.length ? `Wrote ${tracks.length} ${tracks.length === 1 ? "program" : "programs"}` : "Programs written") : two ? "Writing 2 programs" : "Writing program",
      status: planning,
      values: shaLines.length ? shaLines : done(planning) ? ["written"] : [],
    },
    {
      key: "executing",
      label: executing === "failed" ? "Execution failed" : done(executing) ? `Ran ${receipts.length === 2 ? "both " : ""}in ${runtime}` : "Sandbox execution",
      status: executing,
      values: timeLines,
    },
    {
      key: "validating",
      label: two ? "Gate + published map" : "Gate",
      status: validating,
      values: done(validating) || tally ? gateLines : [],
    },
    ...(two ? [{ key: "agree", label: agree === "failed" ? "Programs differ" : agree === "done" ? "Programs agree" : "Agreement check", status: agree, values: agree === "done" ? ["identical"] : agree === "failed" ? ["mismatch"] : [] }] : []),
    { key: "explaining", label: done(explaining) ? "Explained" : "Explaining", status: explaining, values: explaining === "done" ? ["checked"] : [] },
  ]

  const fixes = repairs(run)
  const repairing = status("repairing")
  const repairStage = run?.stages.filter((s) => s.name === "repairing").at(-1)

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex items-start gap-1" aria-label="Agent loop">
        {loop.map((s, i) => {
          const live = s.status === "running"
          return (
            <li key={s.key} className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-1">
                <LoopDot status={s.status} />
                {i < loop.length - 1 ? (
                  <span aria-hidden className={cn("h-px flex-1 transition-colors duration-200", s.status === "done" ? "bg-foreground/40" : "bg-border")} />
                ) : null}
              </div>
              <span
                className={cn(
                  "pr-1 text-[11.5px] leading-tight text-balance",
                  live ? "font-medium text-foreground" : s.status === "pending" || s.status === "skipped" ? "text-subtle" : "text-muted-foreground",
                  s.status === "failed" && "text-destructive",
                )}
              >
                {s.label}
                <span className="sr-only"> — {s.status}</span>
              </span>
              <span className={cn("flex min-h-4 flex-col pr-1 font-mono text-[10.5px] leading-[1.35] tabular-nums", s.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {s.values.length ? s.values.map((v) => <span key={v} className="truncate">{v}</span>) : <span>{live ? "…" : ""}</span>}
              </span>
            </li>
          )
        })}
      </ol>

      {two ? (
        <p className="text-[11.5px] leading-snug text-muted-foreground">
          Requested: <span className="font-medium text-foreground/80">A</span> {PROGRAM_KIND.A} · <span className="font-medium text-foreground/80">B</span> {PROGRAM_KIND.B}, written independently for separate containers.
          {cross.consistency.length ? " Published-map checks are shown in run details." : ""}
        </p>
      ) : null}

      {fixes.length || repairing === "running" ? (
        <div className="flex items-start gap-2 rounded-lg border border-dashed px-2.5 py-2 text-[12px] leading-snug">
          <RotateCcw
            aria-hidden
            className={cn("mt-0.5 size-3.5 shrink-0", repairing === "running" ? "animate-spin text-brand [animation-duration:2s]" : "text-muted-foreground")}
          />
          <div className="min-w-0">
            {fixes.map((f) => (
              <div key={`${f.program}-${f.failed.attempt}`}>
                <span className="font-medium">
                  Program {f.program} v{f.failed.attempt} {f.failed.receipt ? "rejected" : missingReceiptCopy(f.failed).repairLabel}
                </span>
                {f.reason ? <span className="text-muted-foreground">: {f.reason}</span> : null}
              </div>
            ))}
            <div className="mt-0.5 flex items-center gap-1 text-muted-foreground">
              <CornerDownRight aria-hidden className="size-3 shrink-0" />
              {repairing === "running"
                ? (repairStage?.detail ?? "Regenerating the failing program from check names only…")
                : `Regenerated ${fixes.map((f) => f.program).filter((p, i, a) => a.indexOf(p) === i).join(" and ")} from the failed check names only${
                    tracks.length === 2 && fixes.every((f) => f.program === fixes[0].program) ? `; ${fixes[0].program === "A" ? "B" : "A"} kept` : ""
                  }`}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LoopDot({ status }: { status: StepStatus | StageStatus }) {
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
