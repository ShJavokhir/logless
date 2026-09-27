import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowDown, Check, CircleCheck, CircleX, Copy, LoaderCircle, OctagonX, ShieldAlert, ShieldCheck, Timer, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { api, describeError } from "@/lib/api"
import type { Receipt, Run, RunStage, Snapshot } from "@/lib/types"
import { durationMs, fmtBytes, fmtClock, fmtDuration, fmtInt, fmtMs } from "@/lib/format"
import { stageLabel } from "@/lib/runs"
import { tokenLines } from "@/lib/highlight"
import { modelLabel } from "@/lib/snapshot"
import { useRun } from "@/hooks/useRun"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { QUESTION, RUN_SUBTITLE } from "@/lib/copy"

export function RunDetailsSheet({
  open,
  onOpenChange,
  run,
  snapshot,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  run: Run | null
  snapshot: Snapshot
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[680px]">
        <SheetHeader className="border-b px-5 pt-4 pb-3.5">
          <div className="flex items-center gap-2 pr-8 text-[12px] text-muted-foreground">
            <span className="font-mono">{run?.run_id ?? "no run"}</span>
            {run?.intent ? <span>· {QUESTION[run.intent]}</span> : null}
          </div>
          <SheetTitle className="text-[17px] font-semibold">Run details</SheetTitle>
          <SheetDescription className="text-[13px] leading-snug text-pretty">{RUN_SUBTITLE}</SheetDescription>
          <a
            href="#containment"
            onClick={(e) => {
              e.preventDefault()
              document.getElementById("containment")?.scrollIntoView({ behavior: "smooth", block: "start" })
            }}
            className="mt-1 inline-flex w-fit items-center gap-1 rounded-sm text-[12px] font-medium text-brand hover:underline"
          >
            <ShieldAlert aria-hidden className="size-3.5" />
            Containment check
            <ArrowDown aria-hidden className="size-3" />
          </a>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-6 px-5 py-5">
            {run ? (
              <>
                <Timeline stages={run.stages} />
                {run.code ? <CodeBlock code={run.code} sha={run.receipt?.code_sha256 ?? null} /> : null}
                {run.receipt ? <ReceiptGrid receipt={run.receipt} /> : null}
                {run.verdict ? <GateVerdict verdict={run.verdict} attempts={run.attempts} /> : null}
                <Models snapshot={snapshot} />
              </>
            ) : (
              <p className="text-[13px] text-muted-foreground">Ask one of the two questions to see a run here.</p>
            )}
            <Containment />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 id={id} className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          {title}
        </h3>
        {aside ? <div className="text-[11.5px] text-muted-foreground">{aside}</div> : null}
      </div>
      {children}
    </section>
  )
}

function StatusIcon({ status }: { status: RunStage["status"] }) {
  if (status === "done") return <CircleCheck aria-label="done" className="size-4 text-ok" />
  if (status === "failed") return <CircleX aria-label="failed" className="size-4 text-destructive" />
  if (status === "running") return <LoaderCircle aria-label="running" className="size-4 animate-spin text-brand" />
  return <span aria-label={status} className="block size-4 rounded-full border border-dashed border-subtle/70" />
}

function Timeline({ stages }: { stages: RunStage[] }) {
  const t0 = stages.find((s) => s.started_at)?.started_at ?? null
  return (
    <Section title="Stages" id="rd-stages" aside="UTC · offset from start">
      <ol className="flex flex-col">
        {stages.map((s, i) => (
          <li key={i} className="grid grid-cols-[1rem_1fr_auto] gap-x-3 border-b border-border/60 py-2 last:border-b-0">
            <span className="mt-0.5">
              <StatusIcon status={s.status} />
            </span>
            <div className="min-w-0">
              <div className={cn("text-[13px] font-medium", s.status === "pending" && "text-subtle")}>{stageLabel(s.name)}</div>
              {s.detail ? <div className="text-[12px] leading-snug text-muted-foreground">{s.detail}</div> : null}
            </div>
            <div className="text-right font-mono text-[11.5px] leading-tight text-muted-foreground tabular-nums">
              <div>{s.started_at ? fmtClock(s.started_at) : "—"}</div>
              <div className="text-subtle">
                {s.started_at && t0 ? `+${fmtDuration(durationMs(t0, s.started_at))}` : ""}
                {s.finished_at ? ` · ${fmtDuration(durationMs(s.started_at, s.finished_at))}` : s.status === "running" ? " · …" : ""}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  )
}

const TOKEN_CLASS: Record<string, string> = {
  kw: "text-[oklch(0.45_0.13_300)]",
  str: "text-[oklch(0.47_0.1_150)]",
  com: "text-subtle italic",
  num: "text-[oklch(0.5_0.12_45)]",
  fn: "text-[oklch(0.45_0.11_255)]",
  plain: "",
}

function CodeBlock({ code, sha }: { code: string; sha: string | null }) {
  const lines = useMemo(() => tokenLines(code.replace(/\n$/, "")), [code])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      toast.success("Program copied")
    } catch {
      toast.error("Clipboard unavailable")
    }
  }
  return (
    <Section
      title="Generated program"
      id="rd-code"
      aside={
        <span className="flex items-center gap-2">
          {sha ? <span className="font-mono">sha256 {sha.slice(0, 12)}</span> : null}
          <Button variant="ghost" size="icon-xs" onClick={() => void copy()} aria-label="Copy program">
            <Copy />
          </Button>
        </span>
      }
    >
      <div className="max-h-[340px] overflow-auto rounded-lg border bg-muted/50 py-2.5" tabIndex={0} aria-label="Generated Python program">
        <pre className="font-mono text-[11.5px] leading-[1.6]">
          <code className="grid grid-cols-[auto_1fr]">
            {lines.map((toks, i) => (
              <span key={i} className="contents">
                <span aria-hidden className="pr-3 pl-3 text-right text-subtle/80 select-none tabular-nums">
                  {i + 1}
                </span>
                <span className="pr-4 whitespace-pre">
                  {toks.length ? toks.map((t, j) => (
                    <span key={j} className={TOKEN_CLASS[t.t]}>
                      {t.v}
                    </span>
                  )) : " "}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </div>
      <p className="mt-1.5 text-[11.5px] text-muted-foreground">The program contains no data. It only sees typed assignment files mounted read-only at /in.</p>
    </Section>
  )
}

function Row({ k, v, ok }: { k: string; v: ReactNode; ok?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 text-[12.5px] last:border-b-0">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="flex items-center gap-1.5 text-right font-mono text-[12px] tabular-nums">
        {v}
        {ok === true ? <Check aria-label="ok" className="size-3.5 text-ok" /> : ok === false ? <X aria-label="not ok" className="size-3.5 text-destructive" /> : null}
      </dd>
    </div>
  )
}

function ReceiptGrid({ receipt }: { receipt: Receipt }) {
  const L = receipt.limits
  return (
    <Section title="Execution receipt" id="rd-receipt" aside={<span className="font-mono">job {receipt.job_id.slice(0, 8)}</span>}>
      <div className="grid gap-x-6 sm:grid-cols-2">
        <dl>
          <Row k="Runtime" v={receipt.runtime === "runsc" ? "runsc (gVisor)" : `${receipt.runtime} (no gVisor)`} ok={receipt.runtime === "runsc"} />
          <Row k="Image" v={receipt.image} />
          <Row k="Code sha256" v={receipt.code_sha256.slice(0, 12)} />
          <Row k="Exit code" v={receipt.exit_code === null ? "— (killed)" : receipt.exit_code} ok={receipt.exit_code === 0 ? true : undefined} />
          <Row k="Elapsed" v={fmtMs(receipt.elapsed_ms)} />
          <Row k="Timed out" v={receipt.timed_out ? "yes" : "no"} />
          <Row k="Output" v={fmtBytes(receipt.output_bytes)} />
          <Row k="Container removed" v={receipt.container_removed ? "yes" : "no"} ok={receipt.container_removed} />
        </dl>
        <dl>
          <Row k="CPU" v={`${L.cpus} vCPU`} />
          <Row k="Memory" v={`${fmtInt(L.memory_mb)} MiB`} />
          <Row k="Processes" v={`${L.pids} pids`} />
          <Row k="Time limit" v={`${L.timeout_s} s`} />
          <Row k="Network" v={L.network} ok={L.network === "none"} />
          <Row k="Root filesystem" v={L.read_only_root ? "read-only" : "writable"} ok={L.read_only_root} />
          <Row k="Host" v={receipt.host} />
          <Row k="Window" v={`${fmtClock(receipt.started_at)}–${fmtClock(receipt.finished_at).slice(-6)}`} />
        </dl>
      </div>
    </Section>
  )
}

function GateVerdict({ verdict, attempts }: { verdict: NonNullable<Run["verdict"]>; attempts: number }) {
  const passed = verdict.checks.filter((c) => c.passed).length
  return (
    <Section
      title="Egress gate"
      id="rd-gate"
      aside={
        <span className={cn("font-medium", verdict.passed ? "text-ok" : "text-destructive")}>
          {verdict.passed ? "Passed" : "Rejected"} · {passed}/{verdict.checks.length} · {attempts} {attempts === 1 ? "attempt" : "attempts"}
        </span>
      }
    >
      <ul className="flex flex-col gap-1.5">
        {verdict.checks.map((c) => (
          <li key={c.name} className="grid grid-cols-[1rem_1fr] gap-x-2.5 text-[13px]">
            {c.passed ? <CircleCheck aria-label="passed" className="mt-0.5 size-4 text-ok" /> : <CircleX aria-label="failed" className="mt-0.5 size-4 text-destructive" />}
            <div>
              <div className="font-medium">{c.name}</div>
              <div className="font-mono text-[11.5px] text-muted-foreground">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      {attempts >= 2 ? (
        <p className="mt-2 text-[12px] text-muted-foreground">The first program was rejected; GLM repaired it from the gate's check names (never from data) and the second attempt passed.</p>
      ) : null}
    </Section>
  )
}

function Models({ snapshot }: { snapshot: Snapshot }) {
  const m = snapshot.provenance.models
  const rows: [string, string | undefined][] = [
    ["Program & explanation", m.analysis_code ?? m.explanation],
    ["Cluster labels & friction", m.friction ?? m.classification],
    ["Search relevance", m.relevance],
  ]
  return (
    <Section title="Models" id="rd-models">
      <dl>
        {rows
          .filter((r): r is [string, string] => !!r[1])
          .map(([k, id]) => (
            <Row key={k} k={k} v={<span title={modelLabel(id)}>{id}</span>} />
          ))}
      </dl>
    </Section>
  )
}

// ---------------------------------------------------------------- containment

function Containment() {
  const sectionRef = useRef<HTMLElement>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { run } = useRun(runId)

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const { run_id } = await api.startContainment()
      setRunId(run_id)
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }))
    } catch (err) {
      setError(describeError(err, "The containment check could not start."))
    } finally {
      setStarting(false)
    }
  }

  const active = !!run && run.state !== "completed" && run.state !== "failed"
  return (
    <section ref={sectionRef} id="containment" aria-labelledby="rd-contain" className={cn("scroll-mt-4 rounded-xl border bg-muted/30 p-4", (runId || starting) && "min-h-[calc(100dvh-190px)]")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="rd-contain" className="flex items-center gap-1.5 text-[14px] font-semibold">
            <ShieldAlert aria-hidden className="size-4 text-foreground/70" />
            Containment check
          </h3>
          <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
            Submits a program that never stops, then one that tries to export per-person rows. The sandbox must kill the first at its deadline; the gate must reject the second.
          </p>
        </div>
        <Button variant={run ? "outline" : "default"} size="sm" onClick={() => void start()} disabled={starting || active}>
          {starting || active ? <LoaderCircle className="animate-spin" /> : <ShieldAlert />}
          {run && !active ? "Run again" : "Run containment check"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      {run ? <ContainmentProgress run={run} /> : null}
    </section>
  )
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    let raf = 0
    const tick = () => {
      setNow(Date.now())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])
  return now
}

function ContainmentProgress({ run }: { run: Run }) {
  const stage = (name: string) => run.stages.find((s) => s.name === name)
  const runaway = stage("runaway") ?? run.stages[0]
  const c = run.containment
  const deadline = c?.deadline_ms ?? 2000
  const runawayRunning = runaway?.status === "running"
  // local clock for the live bar (tolerates server clock skew)
  const [seenAt] = useState(() => Date.now())
  const now = useNow(runawayRunning)
  const liveElapsed = runawayRunning ? Math.min(deadline, now - seenAt + 150) : null
  const killed = !!c?.killed || (runaway && runaway.status !== "running" && runaway.status !== "pending")
  const measured = c?.elapsed_ms ?? run.receipt?.elapsed_ms ?? null
  // Final values come from `containment` once the run completes; before that,
  // named stages (if the backend reports them) drive the live checklist.
  const phaseState = (name: string, final: boolean | undefined): boolean | "wait" | "pending" => {
    if (final !== undefined) return final
    const st = stage(name)?.status
    return st === "done" ? true : st === "failed" ? false : st === "running" ? "wait" : "pending"
  }
  const leak = stage("leak_attempt")
  const leakVisible = !!c || (!!leak && leak.status !== "pending")
  const leakRunning = !c && leak?.status === "running"

  return (
    <div className="mt-4 flex flex-col gap-3" aria-live="polite">
      {/* phase 1: runaway */}
      <div className={cn("rounded-lg border bg-card p-3.5", killed && "border-foreground/15")}>
        {!killed ? (
          <>
            <div className="flex items-center justify-between text-[13px]">
              <span className="flex items-center gap-2 font-medium">
                <Timer aria-hidden className="size-4 text-brand" />
                Runaway program running
              </span>
              <span className="font-mono text-[12px] tabular-nums">
                {fmtInt(liveElapsed ?? 0)} / {fmtInt(deadline)} ms
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-faint" aria-hidden>
              <div className="h-full rounded-full bg-brand" style={{ width: `${((liveElapsed ?? 0) / deadline) * 100}%` }} />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2.5">
              <OctagonX aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div className="min-w-0">
                <div className="text-[16px] leading-tight font-semibold">Execution limit reached · sandbox terminated</div>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono tabular-nums">
                  <span className="text-[26px] leading-none font-semibold tracking-tight">{measured !== null ? fmtInt(measured) : "—"} ms</span>
                  <span className="text-[12.5px] text-muted-foreground">
                    measured vs {fmtInt(deadline)} ms deadline
                    {measured !== null ? ` · +${fmtInt(Math.max(0, measured - deadline))} ms to kill` : ""}
                  </span>
                </div>
              </div>
            </div>
            <ul className="mt-3 grid gap-1.5 text-[13px] sm:grid-cols-3">
              <CheckItem label="Container removed" state={phaseState("cleanup", c?.container_removed)} />
              <CheckItem label="App health ok" state={phaseState("health", c ? c.app_health === "ok" : undefined)} />
              <CheckItem label="Follow-up run passed" state={phaseState("followup", c?.followup_passed)} />
            </ul>
          </>
        )}
      </div>

      {/* phase 2: leak attempt */}
      {leakVisible ? (
        <div className="rounded-lg border bg-card p-3.5">
          {leakRunning || (!c && leak?.status !== "done") ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <LoaderCircle aria-hidden className="size-4 animate-spin text-brand" />
              {leak?.detail ?? "Checking the leak attempt"}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2.5">
                {c?.leak_attempt_rejected === false ? (
                  <CircleX aria-hidden className="size-5 shrink-0 text-destructive" />
                ) : (
                  <ShieldCheck aria-hidden className="size-5 shrink-0 text-ok" />
                )}
                <div className="text-[15px] leading-tight font-semibold">
                  {c?.leak_attempt_rejected === false ? "Leak attempt was NOT rejected" : "Leak attempt rejected by the gate"}
                </div>
              </div>
              {c?.leak_rejection_checks.length ? (
                <ul className="mt-2.5 flex flex-col gap-1 pl-7.5">
                  {c.leak_rejection_checks.map((chk) => (
                    <li key={chk} className="flex items-center gap-2 font-mono text-[12px]">
                      <X aria-hidden className="size-3.5 shrink-0 text-destructive" />
                      {chk}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 pl-7.5 text-[12px] text-muted-foreground">Nothing from that program's output left the sandbox host.</p>
            </>
          )}
        </div>
      ) : null}

      {run.code ? (
        <details className="group rounded-lg border bg-card px-3.5 py-2.5 text-[12.5px]">
          <summary className="cursor-pointer text-muted-foreground select-none marker:text-subtle">The hostile program</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted/60 p-3 font-mono text-[11.5px] leading-[1.55] whitespace-pre">{run.code}</pre>
        </details>
      ) : null}

      {run.receipt ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          {run.run_id} · {run.receipt.runtime} · {run.receipt.image} · timed_out {String(run.receipt.timed_out)} · exit {run.receipt.exit_code ?? "—"}
        </p>
      ) : null}
    </div>
  )
}

function CheckItem({ label, state }: { label: string; state: boolean | "wait" | "pending" }) {
  return (
    <li className={cn("flex items-center gap-1.5", state === "pending" && "text-subtle")}>
      {state === true ? (
        <CircleCheck aria-label="ok" className="size-4 text-ok" />
      ) : state === false ? (
        <CircleX aria-label="failed" className="size-4 text-destructive" />
      ) : state === "wait" ? (
        <LoaderCircle aria-label="checking" className="size-4 animate-spin text-brand" />
      ) : (
        <span className="block size-4 rounded-full border border-dashed border-subtle/70" aria-label="pending" />
      )}
      {label}
    </li>
  )
}
