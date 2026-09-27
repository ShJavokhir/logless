import { Check, CornerDownRight, RotateCcw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Run } from "@/lib/types"
import { deriveSteps, type Step, type StepKey } from "@/lib/runs"
import { fmtMs } from "@/lib/format"

const LABEL: Record<Exclude<StepKey, "repairing">, { live: string; done: string }> = {
  interpreting: { live: "Interpreting", done: "Interpreted" },
  planning: { live: "Writing program", done: "Wrote program" },
  executing: { live: "Running in gVisor", done: "Ran in gVisor" },
  validating: { live: "Gate checking", done: "Gate" },
  explaining: { live: "Explaining", done: "Explained" },
}

/** Evidence for each loop step, only from data the run actually carries. */
function valueOf(key: StepKey, step: Step, run: Run | null): string | null {
  if (!run) return null
  const log = run.attempts_log ?? []
  const lastAttempt = log[log.length - 1]
  const receipt = [...log].reverse().find((a) => a.receipt)?.receipt ?? run.receipt
  const verdict = lastAttempt?.verdict ?? run.verdict
  switch (key) {
    case "interpreting":
      return step.status === "done" ? "plan ready" : step.status === "failed" ? "no plan" : null
    case "planning": {
      const sha = lastAttempt?.code_sha256 ?? receipt?.code_sha256
      if (sha) return sha.slice(0, 8)
      return step.status === "done" ? "written" : null
    }
    case "executing":
      if (!receipt) return null
      return `${(run.attempts ?? 0) >= 2 ? "×2 · " : ""}${fmtMs(receipt.elapsed_ms)}`
    case "validating":
      if (!verdict) return null
      return `${verdict.checks.filter((c) => c.passed).length}/${verdict.checks.length}${verdict.passed ? "" : " ✕"}`
    case "explaining":
      return step.status === "done" ? "text checked" : null
    default:
      return null
  }
}

export function AgentLoop({ run, forQuestion = false }: { run: Run | null; forQuestion?: boolean }) {
  const steps = deriveSteps(run, forQuestion)
  const main = steps.filter((s) => s.key !== "repairing")
  const repair = steps.find((s) => s.key === "repairing")
  const log = run?.attempts_log ?? []
  const first = log[0]
  const failedChecks = first && !first.verdict.passed ? first.verdict.checks.filter((c) => !c.passed).map((c) => c.name) : []
  const firstNotRun = !!first && !first.receipt
  const reason = log.find((a) => a.repair_reason)?.repair_reason ?? null

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex items-start gap-1" aria-label="Agent loop">
        {main.map((s, i) => {
          const key = s.key as Exclude<StepKey, "repairing">
          const live = s.status === "running"
          const value = valueOf(s.key, s, run)
          return (
            <li key={s.key} className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-1">
                <LoopDot status={s.status} />
                {i < main.length - 1 ? (
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
                {s.status === "done" || s.status === "failed" ? LABEL[key].done : LABEL[key].live}
                <span className="sr-only"> — {s.status}</span>
              </span>
              <span className={cn("min-h-4 truncate pr-1 font-mono text-[10.5px] tabular-nums", s.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {value ?? (live ? "…" : "")}
              </span>
            </li>
          )
        })}
      </ol>

      {(repair && repair.status !== "pending") || log.length >= 2 ? (
        <div className="flex items-start gap-2 rounded-lg border border-dashed px-2.5 py-2 text-[12px] leading-snug">
          <RotateCcw aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", repair?.status === "running" ? "animate-spin text-brand [animation-duration:2s]" : "text-muted-foreground")} />
          <div className="min-w-0">
            <span className="font-medium">{firstNotRun ? "Program 1 stopped by the static pre-check" : "Attempt 1 rejected by the gate"}</span>
            {failedChecks.length ? <span className="text-muted-foreground">: {failedChecks.join(", ")}</span> : null}
            {first ? (
              <span className="ml-1 font-mono text-[10.5px] text-subtle">
                ({first.code_sha256.slice(0, 8)}
                {first.receipt ? ` · ${fmtMs(first.receipt.elapsed_ms)}` : " · not run"})
              </span>
            ) : null}
            <div className="mt-0.5 flex items-center gap-1 text-muted-foreground">
              <CornerDownRight aria-hidden className="size-3 shrink-0" />
              {repair?.status === "running" ? "GLM is repairing the program from the failed check names only…" : `Repaired${reason ? ` for "${reason}"` : ""} and ran again`}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LoopDot({ status }: { status: Step["status"] }) {
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
