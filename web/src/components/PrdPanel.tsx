import { ClipboardCopy, Download, FileText, LoaderCircle, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import type { Node as SnapshotNode, Prd } from "@/lib/types"
import type { SnapshotIndex } from "@/lib/snapshot"
import { splitCitations } from "@/lib/citations"
import { METRIC_NAMES, prdMarkdown } from "@/lib/prd"
import { fmtClock } from "@/lib/format"
import { usePrd } from "@/hooks/usePrd"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { EvidenceTag } from "./common"

export function PrdPanel({
  index,
  leaf,
  onHoverCitation,
}: {
  index: SnapshotIndex
  leaf: SnapshotNode
  onHoverCitation: (id: string | null) => void
}) {
  const { prd, busy, error: errorMessage, run, request } = usePrd(index.snapshot.snapshot_id, leaf.id)

  if (prd) return <PrdCard prd={prd} leaf={leaf} onHoverCitation={onHoverCitation} />

  const liveStage = run?.stages.find((s) => s.status === "running")

  return (
    <section aria-labelledby="prd-h" className="rounded-xl border border-dashed p-4">
      <div className="flex flex-col gap-3">
        <div>
          <h3 id="prd-h" className="text-[13.5px] font-medium">
            Hand it to the eng team
          </h3>
          <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
            Drafts a PRD — problem, user stories, requirements, success metrics and a roadmap priority — from this workflow's
            published needs and problems. Every number comes from verified metrics, never from the model.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={request} disabled={busy} aria-busy={busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : errorMessage ? <RotateCcw /> : <FileText />}
            {errorMessage && !busy ? "Try again" : "Draft PRD"}
          </Button>
          <span role="status" aria-live="polite" className="text-[12px] text-muted-foreground">
            {busy ? (liveStage?.detail ?? "Starting…") : null}
          </span>
        </div>
        {errorMessage ? (
          <p role="alert" className="text-[12.5px] text-destructive">
            {errorMessage}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function Cited({ text, known, onHoverCitation }: { text: string; known: Set<string>; onHoverCitation: (id: string | null) => void }) {
  return (
    <>
      {splitCitations(text).map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            className="mr-px ml-1 rounded-[4px] align-[1px]"
            onMouseEnter={() => onHoverCitation(part.id)}
            onMouseLeave={() => onHoverCitation(null)}
            onFocus={() => onHoverCitation(part.id)}
            onBlur={() => onHoverCitation(null)}
            aria-label={`Evidence ${part.id}`}
          >
            <EvidenceTag id={part.id} className={known.has(part.id) ? undefined : "line-through"} />
          </button>
        ),
      )}
    </>
  )
}

function Section({ title, items, known, onHoverCitation }: { title: string; items: string[]; known: Set<string>; onHoverCitation: (id: string | null) => void }) {
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] leading-snug">
        {items.map((s, i) => (
          <li key={i}>
            <Cited text={s} known={known} onHoverCitation={onHoverCitation} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function PrdCard({ prd, leaf, onHoverCitation }: { prd: Prd; leaf: SnapshotNode; onHoverCitation: (id: string | null) => void }) {
  const known = new Set([...(leaf.needs ?? []), ...(leaf.problems ?? [])].map((x) => x.id))
  const md = () => prdMarkdown(prd, leaf)
  const copy = () =>
    navigator.clipboard.writeText(md()).then(
      () => toast.success("PRD copied as Markdown"),
      () => toast.error("Couldn't copy — use Download instead"),
    )
  const download = () => {
    const url = URL.createObjectURL(new Blob([md()], { type: "text/markdown" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `prd-${leaf.id}.md`
    a.click()
    URL.revokeObjectURL(url)
  }
  const level = prd.priority.level
  return (
    <section aria-labelledby="prd-card-h" className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="flex items-start gap-2 border-b bg-brand-soft/60 px-4 py-2.5 text-[12px] leading-snug text-foreground/80">
        <FileText aria-hidden className="mt-px size-3.5 shrink-0 text-brand" />
        <p>
          <span className="font-semibold text-foreground">Draft PRD</span>
          {" · "}
          {prd.label.split(" · ")[1] ?? prd.label}
        </p>
      </div>
      <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-4">
        <div className="flex items-start justify-between gap-3">
          <h3 id="prd-card-h" className="text-[15px] leading-snug font-semibold">
            {prd.title}
          </h3>
          <span
            title={prd.priority.basis}
            className={cn(
              "shrink-0 rounded-md px-2 py-0.5 font-mono text-[11.5px] font-semibold",
              level === "P0" ? "bg-heat-soft text-heat" : level === "P1" ? "bg-warn-soft text-warn" : "bg-muted text-muted-foreground",
            )}
          >
            {level ?? "Unranked"}
            {prd.priority.rank ? ` · #${prd.priority.rank}/${prd.priority.of}` : ""}
          </span>
        </div>
        <p className="-mt-2 text-[11.5px] leading-snug text-muted-foreground">Roadmap priority: {prd.priority.basis}</p>
        <div>
          <h4 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Problem</h4>
          <p className="text-[13px] leading-snug">
            <Cited text={prd.problem} known={known} onHoverCitation={onHoverCitation} />
          </p>
        </div>
        <Section title="User stories" items={prd.user_stories} known={known} onHoverCitation={onHoverCitation} />
        <Section title="Requirements" items={prd.requirements} known={known} onHoverCitation={onHoverCitation} />
        <Section title="Success metrics" items={prd.success_metrics} known={known} onHoverCitation={onHoverCitation} />
        {prd.metrics_used.length ? (
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span>Verified numbers filled in:</span>
            {prd.metrics_used.map((m) => (
              <span key={m.name} className="rounded-[4px] bg-ok-soft px-1.5 py-px font-mono text-[10.5px] text-foreground/80">
                {METRIC_NAMES[m.name] ?? m.name} {m.value}
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button variant="outline" size="sm" onClick={copy}>
            <ClipboardCopy /> Copy Markdown
          </Button>
          <Button variant="outline" size="sm" onClick={download}>
            <Download /> Download .md
          </Button>
          <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
            {prd.model} · {fmtClock(prd.generated_at)} UTC
          </span>
        </div>
      </div>
    </section>
  )
}
