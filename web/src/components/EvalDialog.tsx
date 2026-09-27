import { useEffect, useState } from "react"
import { CircleCheck, CircleMinus, CircleX, RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"
import { api, describeError } from "@/lib/api"
import type { EvalReport } from "@/lib/types"
import { fmtClock, fmtDate } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"

export function EvalDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [report, setReport] = useState<EvalReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open || report) return
    const ctrl = new AbortController()
    api
      .getEval(ctrl.signal)
      .then((r) => {
        setReport(r)
        setError(null)
      })
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) setError(describeError(err, "The evaluation report could not be loaded."))
      })
    return () => ctrl.abort()
  }, [open, report, attempt])

  const scored = report?.checks.filter((c) => c.passed !== null) ?? []
  const met = scored.filter((c) => c.passed).length
  const info = (report?.checks.length ?? 0) - scored.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88dvh] flex-col gap-0 p-0 sm:max-w-[960px]">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle className="text-[17px] font-semibold">Evaluation</DialogTitle>
          <DialogDescription className="text-[13px]">
            {report ? (
              <>
                <span className="font-medium text-foreground">
                  {met} of {scored.length} targets met
                </span>
                {info ? ` · ${info} informational` : ""} · <span className="font-mono">{report.snapshot_id}</span> · generated {fmtDate(report.generated_at)}{" "}
                {fmtClock(report.generated_at)} UTC
              </>
            ) : (
              "How far to trust these numbers: agreement with independent labels, leak tests, reconciliation and containment."
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <div role="alert" className="flex items-center justify-between gap-3 px-5 py-6 text-[13px]">
              <span className="text-destructive">{error}</span>
              <Button variant="outline" size="sm" onClick={() => { setError(null); setAttempt((a) => a + 1) }}>
                <RotateCcw />
                Retry
              </Button>
            </div>
          ) : !report ? (
            <div className="flex flex-col gap-3 px-5 py-5" aria-busy>
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : (
            <table className="w-full table-fixed border-separate border-spacing-0 text-[13px]">
              <caption className="sr-only">Evaluation checks with value, target and result</caption>
              <colgroup>
                <col className="w-[29%]" />
                <col className="w-[19%]" />
                <col className="w-[11%]" />
                <col className="w-[7%]" />
                <col />
              </colgroup>
              <thead className="sticky top-0 bg-popover text-left text-[11px] tracking-[0.04em] text-muted-foreground uppercase [&_th]:border-b [&_th]:px-3 [&_th]:py-2 [&_th]:font-medium">
                <tr>
                  <th scope="col" className="pl-5!">Check</th>
                  <th scope="col">Value</th>
                  <th scope="col">Target</th>
                  <th scope="col" className="text-center">Result</th>
                  <th scope="col" className="pr-5!">Detail</th>
                </tr>
              </thead>
              <tbody className="[&_td]:border-b [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top">
                {report.checks.map((c) => (
                  <tr key={c.id}>
                    <th scope="row" className="border-b border-border/60 py-2.5 pr-3 pl-5 text-left align-top font-medium">
                      {c.name}
                    </th>
                    <td className="font-mono text-[12.5px] tabular-nums">{c.value}</td>
                    <td className="font-mono text-[12.5px] text-muted-foreground tabular-nums">{c.target}</td>
                    <td className="text-center">
                      <ResultIcon passed={c.passed} />
                    </td>
                    <td className={cn("pr-5! text-[12.5px] leading-snug text-muted-foreground")}>{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="border-t px-5 py-3 text-[11.5px] leading-snug text-muted-foreground">
          We report detected canary leaks, not "zero leaks": canaries are planted conversations carrying invented names and contact details, searched for in everything the browser can receive. Checks without a target are informational.
        </p>
      </DialogContent>
    </Dialog>
  )
}

function ResultIcon({ passed }: { passed: boolean | null }) {
  if (passed === true)
    return (
      <span className="inline-flex items-center gap-1 text-ok">
        <CircleCheck aria-hidden className="size-4" />
        <span className="sr-only">passed</span>
      </span>
    )
  if (passed === false)
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <CircleX aria-hidden className="size-4" />
        <span className="sr-only">failed</span>
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 text-subtle" title="Informational — no pass/fail target">
      <CircleMinus aria-hidden className="size-4" />
      <span className="sr-only">informational</span>
    </span>
  )
}
