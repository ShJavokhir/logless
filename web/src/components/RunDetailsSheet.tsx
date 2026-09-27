import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowDown, Check, CircleCheck, CircleX, Copy, LoaderCircle, OctagonX, ShieldAlert, ShieldCheck, Timer, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { api, describeError } from "@/lib/api"
import type { Receipt, Run, RunStage, Snapshot } from "@/lib/types"
import { durationMs, fmtBytes, fmtClock, fmtDuration, fmtInt, fmtMs } from "@/lib/format"
import { stageLabel } from "@/lib/runs"
import { destructiveView, type CheckState, type DestructiveView } from "@/lib/containment"
import { tokenLines } from "@/lib/highlight"
import { modelLabel } from "@/lib/snapshot"
import { useRun } from "@/hooks/useRun"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ASK_LABEL, RUN_SUBTITLE } from "@/lib/copy"
import { crossChecks, PROGRAM_KIND, PROGRAM_KIND_LONG, programTracks, type ProgramTrack } from "@/lib/programs"
import { planShareNote, planToWords } from "@/lib/plan"
import { proseName } from "@/lib/labels"

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
            {run?.intent ? <span className="truncate">· {ASK_LABEL}</span> : null}
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
                {run.intent === "question" ? <QuestionSummary run={run} snapshot={snapshot} /> : null}
                <Timeline stages={run.stages} />
                {run.attempts_log && run.attempts_log.length ? (
                  <>
                    <Programs key={run.attempts_log.length} tracks={programTracks(run)} />
                    <CrossChecks run={run} />
                  </>
                ) : (
                  <>
                    {run.code ? <CodeBlock code={run.code} sha={run.receipt?.code_sha256 ?? null} /> : null}
                    {run.receipt ? <ReceiptGrid receipt={run.receipt} /> : null}
                    {run.verdict ? <GateVerdict verdict={run.verdict} attempts={run.attempts} /> : null}
                  </>
                )}
                <Models snapshot={snapshot} />
              </>
            ) : (
              <p className="text-[13px] text-muted-foreground">Ask a question to see a run here.</p>
            )}
            <Containment />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function QuestionSummary({ run, snapshot }: { run: Run; snapshot: Snapshot }) {
  const titleOf = (id: string) => {
    const n = snapshot.categories.find((c) => c.id === id) ?? snapshot.clusters.find((c) => c.id === id)
    return n ? proseName(n) : undefined
  }
  return (
    <Section title="Question" id="rd-question">
      <p className="text-[14px] leading-snug font-medium">“{run.question ?? "—"}”</p>
      {run.plan ? (
        <div className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-[12.5px]">
          <div className="text-[10.5px] font-medium tracking-[0.06em] text-muted-foreground uppercase">Validated plan</div>
          <p className="mt-0.5 font-medium">{planToWords(run.plan, titleOf)}</p>
          <p className="mt-1 text-[11.5px] text-muted-foreground">{planShareNote(run.plan)}</p>
          <pre className="mt-1.5 overflow-x-auto font-mono text-[11px] text-muted-foreground">{JSON.stringify(run.plan)}</pre>
        </div>
      ) : run.error?.code === "unsupported_question" ? (
        <p className="mt-1 text-[12.5px] text-muted-foreground">Not answerable: {run.error.message}</p>
      ) : null}
    </Section>
  )
}

/**
 * §0: both independent programs, each with every version it went through
 * (never overwritten): code, receipt and its own gate checks.
 */
function Programs({ tracks }: { tracks: ProgramTrack[] }) {
  const [sel, setSel] = useState(0)
  const track = tracks[Math.min(sel, tracks.length - 1)]
  const two = tracks.length > 1
  return (
    <Section title={two ? "Two independent programs" : "Program"} id="rd-programs" aside={two ? "written separately · separate containers" : undefined}>
      {two ? (
        <div className="mb-3 grid grid-cols-2 gap-2">
          {tracks.map((t, i) => {
            const v = t.latest.verdict
            return (
              <button
                key={t.program}
                type="button"
                onClick={() => setSel(i)}
                aria-pressed={i === sel}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors",
                  i === sel ? "border-foreground/30 bg-muted/70" : "hover:bg-muted/40",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold">
                    Program {t.program} <span className="font-normal text-muted-foreground">· {PROGRAM_KIND[t.program]}</span>
                  </span>
                  {v.passed ? <CircleCheck aria-label="passed" className="size-4 text-ok" /> : <CircleX aria-label="rejected" className="size-4 text-destructive" />}
                </div>
                <div className="mt-1 font-mono text-[11px] leading-relaxed text-muted-foreground tabular-nums">
                  <div>sha256 {t.latest.code_sha256.slice(0, 12)}</div>
                  <div>
                    {t.latest.receipt ? `${fmtMs(t.latest.receipt.elapsed_ms)} · exit ${t.latest.receipt.exit_code ?? "—"}` : "not executed"} · gate {v.checks.filter((c) => c.passed).length}/{v.checks.length}
                  </div>
                  <div>{t.attempts.length > 1 ? `${t.attempts.length} versions · repaired` : "1 version"}</div>
                </div>
              </button>
            )
          })}
        </div>
      ) : null}
      <ProgramVersions key={track.program} track={track} />
    </Section>
  )
}

function ProgramVersions({ track }: { track: ProgramTrack }) {
  const [sel, setSel] = useState(track.attempts.length - 1)
  const a = track.attempts[Math.min(sel, track.attempts.length - 1)]
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-muted-foreground">
        Program {track.program} uses {PROGRAM_KIND_LONG[track.program]}.
      </p>
      {track.attempts.length > 1 ? (
        <div role="tablist" aria-label={`Program ${track.program} versions`} className="inline-flex w-fit rounded-lg border p-0.5">
          {track.attempts.map((att, i) => (
            <button
              key={att.attempt}
              type="button"
              role="tab"
              aria-selected={att === a}
              onClick={() => setSel(i)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] transition-colors",
                att === a ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {att.verdict.passed ? <CircleCheck aria-hidden className="size-3.5 text-ok" /> : <CircleX aria-hidden className="size-3.5 text-destructive" />}
              Version {att.attempt} · {att.verdict.passed ? "passed" : att.receipt ? "rejected" : "pre-check"}
            </button>
          ))}
        </div>
      ) : null}
      {a.repair_reason ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-[12.5px]">
          Did not pass: <span className="font-medium">{a.repair_reason}</span>. The repair prompt got only this fixed-vocabulary reason, never values or sandbox output.
        </p>
      ) : null}
      <div role="tabpanel" className="flex flex-col gap-5">
        <CodeBlock code={a.code} sha={a.code_sha256} />
        {a.receipt ? (
          <ReceiptGrid receipt={a.receipt} />
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-2 text-[12.5px] text-muted-foreground">
            Not executed: the static pre-check rejected this program before it reached the sandbox.
          </p>
        )}
        <GateVerdict verdict={a.verdict} attempts={a.attempt} title={`Gate · program ${track.program}`} />
      </div>
    </div>
  )
}

/** Run-level checks: consistency with the published map, and agreement. */
function CrossChecks({ run }: { run: Run }) {
  const x = crossChecks(run)
  const checks = [...x.consistency, ...x.other, ...(x.agreement ? [x.agreement] : [])]
  const two = programTracks(run).length > 1
  if (!checks.length && !two) return null
  return (
    <Section title="Cross-checks" id="rd-cross" aside={x.agreement ? (x.agreement.passed ? "programs agree" : "programs disagree") : undefined}>
      {checks.length ? (
        <ul className="flex flex-col gap-1.5">
          {checks.map((c) => (
            <li key={c.name} className="grid grid-cols-[1rem_1fr] gap-x-2.5 text-[13px]">
              {c.passed ? <CircleCheck aria-label="passed" className="mt-0.5 size-4 text-ok" /> : <CircleX aria-label="failed" className="mt-0.5 size-4 text-destructive" />}
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="font-mono text-[11.5px] text-muted-foreground">{c.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {!x.consistency.length && run.state === "completed" ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          This plan can't be derived from published numbers (for example, distinct people with a friction signal), so agreement between the two programs is the check.
        </p>
      ) : x.consistency.length ? (
        <p className="mt-2 text-[12px] text-muted-foreground">The published map comes from the pipeline and the programs from the agent, so these are independent cross-checks.</p>
      ) : null}
    </Section>
  )
}

/** "logless-analysis:1@sha256:91c87e…" → "logless-analysis:1 · 91c87e91" */
function shortImage(image: string): string {
  const [name, digest] = image.split("@")
  const hash = digest?.replace(/^sha256:/, "")
  return hash ? `${name} · ${hash.slice(0, 8)}` : name
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
          <Row k="Image" v={<span title={receipt.image}>{shortImage(receipt.image)}</span>} />
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

function GateVerdict({ verdict, attempts, title = "Egress gate" }: { verdict: NonNullable<Run["verdict"]>; attempts: number; title?: string }) {
  const passed = verdict.checks.filter((c) => c.passed).length
  return (
    <Section
      title={title}
      id="rd-gate"
      aside={
        <span className={cn("font-medium", verdict.passed ? "text-ok" : "text-destructive")}>
          {verdict.passed ? "Passed" : "Rejected"} · {passed}/{verdict.checks.length}
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
      {attempts >= 2 && verdict.passed ? (
        <p className="mt-2 text-[12px] text-muted-foreground">This version was regenerated from the previous version's failed check names (never from data) and passed.</p>
      ) : null}
    </Section>
  )
}

function Models({ snapshot }: { snapshot: Snapshot }) {
  const m = snapshot.provenance.models
  const rows: [string, string | undefined][] = [
    ["Programs A/B & explanation", m.analysis_code ?? m.explanation],
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
            Submits a runaway program, a destructive <code className="rounded bg-muted px-1 font-mono text-[11.5px] text-foreground">rm -rf /</code>, and a program that tries to
            export per-person rows. The sandbox must kill the first at its deadline and absorb the second; the gate must reject the third.
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
  const destructiveStage = stage("destructive")
  const dview = destructiveView(c?.destructive, destructiveStage?.status)
  // shown once its stage has started, or whenever the final object carries it
  const destructiveVisible = !!c?.destructive || (!!destructiveStage && destructiveStage.status !== "pending")
  const leak = stage("leak_attempt")
  // `containment` can arrive before the run ends; its leak fields are final only once the leak
  // stage has settled (or the run has ended), so never show a verdict before then.
  const terminal = run.state === "completed" || run.state === "failed"
  const leakSettled = terminal || leak?.status === "done" || leak?.status === "failed" || leak?.status === "skipped"
  const leakVisible = leakSettled || (!!leak && leak.status !== "pending")

  return (
    <div className="mt-3 flex flex-col gap-2.5" aria-live="polite">
      {/* phase 1: runaway */}
      <div className={cn("rounded-lg border bg-card px-3.5 py-3", killed && "border-foreground/15")}>
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
                <div className="text-[15px] leading-tight font-semibold">Execution limit reached · sandbox terminated</div>
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono tabular-nums">
                  <span className="text-[22px] leading-none font-semibold tracking-tight">{measured !== null ? fmtInt(measured) : "—"} ms</span>
                  <span className="text-[12.5px] text-muted-foreground">
                    measured vs {fmtInt(deadline)} ms deadline
                    {measured !== null ? ` · +${fmtInt(Math.max(0, measured - deadline))} ms to kill` : ""}
                  </span>
                </div>
              </div>
            </div>
            <ul className="mt-2.5 grid gap-1.5 text-[12.5px] sm:grid-cols-3">
              <CheckItem label="Container removed" state={phaseState("cleanup", c?.container_removed)} />
              <CheckItem label="App health ok" state={phaseState("health", c ? c.app_health === "ok" : undefined)} />
              <CheckItem label="Follow-up run passed" state={phaseState("followup", c?.followup_passed)} />
            </ul>
          </>
        )}
      </div>

      {/* phase 2: destructive command */}
      {destructiveVisible ? <DestructiveCard view={dview} /> : null}

      {/* phase 3: leak attempt */}
      {leakVisible ? (
        <div className="rounded-lg border bg-card px-3.5 py-3">
          {!leakSettled ? (
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
                <div className="text-[14.5px] leading-tight font-semibold">
                  {c?.leak_attempt_rejected === false ? "Leak attempt was NOT rejected" : "Leak attempt rejected by the gate"}
                </div>
              </div>
              {c?.leak_rejection_checks.length ? (
                <ul className="mt-2 flex flex-col gap-0.5 pl-7.5">
                  {c.leak_rejection_checks.map((chk) => {
                    const detail = run.verdict?.checks.find((v) => v.name === chk && !v.passed)?.detail
                    return (
                      <li key={chk} className="grid grid-cols-[0.875rem_1fr] gap-x-2 text-[12.5px]">
                        <X aria-hidden className="mt-0.5 size-3.5 text-destructive" />
                        <span className="font-medium">{chk}</span>
                        {detail ? (
                          <span className="col-start-2 truncate font-mono text-[11px] text-muted-foreground" title={detail}>
                            {detail}
                          </span>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              <p className="mt-1.5 pl-7.5 text-[11.5px] text-muted-foreground">The gate rejected it on the app VM, so none of that program's output reached the browser.</p>
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
          {run.run_id} · {run.receipt.runtime} · {shortImage(run.receipt.image)} · timed_out {String(run.receipt.timed_out)} · exit {run.receipt.exit_code ?? "—"}
        </p>
      ) : null}
    </div>
  )
}

function DestructiveCard({ view }: { view: DestructiveView }) {
  const running = view.headline === "running" || view.headline === "pending"
  const failed = view.headline === "not_contained"
  return (
    <div className={cn("rounded-lg border bg-card px-3.5 py-3", failed && "border-destructive/30")}>
      <div className="flex items-center gap-2.5">
        {running ? (
          <LoaderCircle aria-hidden className="size-5 shrink-0 animate-spin text-brand" />
        ) : failed ? (
          <CircleX aria-hidden className="size-5 shrink-0 text-destructive" />
        ) : (
          <ShieldCheck aria-hidden className="size-5 shrink-0 text-ok" />
        )}
        <div className="min-w-0 flex-1 text-[14.5px] leading-tight font-semibold">
          {running ? "Running a destructive command…" : failed ? "Destructive command NOT contained" : "Destructive command absorbed"}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-7.5">
        <code className="inline-block rounded-md bg-foreground px-2 py-0.5 font-mono text-[12px] text-background">$ {view.command}</code>
        {view.exitCode !== null ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            exit {view.exitCode}
            {view.refused !== null ? ` · ${view.refused.toLocaleString("en-US")} deletions refused` : ""}
          </span>
        ) : null}
      </div>
      <ul className="mt-2 flex flex-col gap-1 pl-7.5 text-[12.5px]">
        {view.checks.map((c) => (
          <li key={c.key} className="flex items-baseline gap-1.5">
            <span className="self-center">
              <CheckGlyph state={c.state} />
            </span>
            <span className={cn(c.state === "pending" && "text-subtle")}>{c.label}</span>
            {c.note ? <span className="text-[11px] text-subtle italic">{c.note}</span> : null}
            {c.state === null ? <span className="text-[11px] text-subtle">· not reported</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CheckGlyph({ state }: { state: CheckState }) {
  if (state === true) return <CircleCheck aria-label="ok" className="size-4 text-ok" />
  if (state === false) return <CircleX aria-label="failed" className="size-4 text-destructive" />
  if (state === "wait") return <LoaderCircle aria-label="checking" className="size-4 animate-spin text-brand" />
  return <span className="block size-4 rounded-full border border-dashed border-subtle/70" aria-label={state === null ? "not reported" : "pending"} />
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
