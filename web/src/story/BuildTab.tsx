import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ClipboardCopy, Download, FileText, LoaderCircle, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import type { SnapshotIndex } from "@/lib/snapshot"
import type { Node as SnapshotNode, Prd } from "@/lib/types"
import { SIGNAL_LABEL } from "@/lib/colors"
import { fmtInt, fmtPct } from "@/lib/format"
import { prdMarkdown } from "@/lib/prd"
import { agentPrompt, stripCitations } from "@/lib/agentPrompt"
import { cn } from "@/lib/utils"
import { usePrd } from "@/hooks/usePrd"
import { Button } from "@/components/ui/button"
import { Bar, SignalIcon } from "@/components/common"
import { LoggyAvatar } from "./LoggyTab"
import { roadmap, P1_TOP, type Item } from "./roadmap"

/** A workflow Loggy suggested building for, and the question that led there. */
export type BuildTarget = { leafId: string; title: string; question: string }

export function BuildTab({ index, target }: { index: SnapshotIndex; target: BuildTarget | null }) {
  const items = useMemo(() => roadmap(index), [index])
  const [selected, setSelected] = useState<string | null>(target?.leafId ?? items[0]?.leaf.id ?? null)
  const [autoDraft, setAutoDraft] = useState<string | null>(target?.leafId ?? null)
  const [showAll, setShowAll] = useState(false)

  // A new hand-off from Loggy selects that workflow and starts drafting.
  const [seen, setSeen] = useState(target)
  if (target !== seen) {
    setSeen(target)
    if (target) {
      setSelected(target.leafId)
      setAutoDraft(target.leafId)
    }
  }

  const visible = showAll ? items : items.filter((it, i) => i < P1_TOP || it.leaf.id === selected)
  const maxFriction = items[0]?.leaf.friction.conversations ?? 1
  const leaf = selected ? index.byId.get(selected) : undefined
  const fromLoggy = target && leaf?.id === target.leafId ? target.question : null

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
      <section aria-labelledby="usecases-h" className="flex min-h-0 flex-col border-b bg-card lg:border-r lg:border-b-0">
        <header className="px-5 pt-6 pb-3">
          <h2 id="usecases-h" className="text-[15px] font-semibold">
            Use cases
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Ranked by conversations with friction.</p>
        </header>
        <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {visible.map((it) => (
            <UseCaseRow
              key={it.leaf.id}
              item={it}
              max={maxFriction}
              active={selected === it.leaf.id}
              fromLoggy={target?.leafId === it.leaf.id}
              onSelect={() => setSelected(it.leaf.id)}
            />
          ))}
          {items.length > visible.length || showAll ? (
            <li className="px-2 pt-2">
              <button type="button" className="text-[13px] font-medium text-brand hover:underline" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${items.length}`}
              </button>
            </li>
          ) : null}
        </ul>
      </section>

      <section aria-label="Spec" className="min-h-0 overflow-y-auto">
        {leaf && leaf.level === 2 ? (
          <Spec key={leaf.id} index={index} leaf={leaf} fromLoggy={fromLoggy} autoDraft={autoDraft === leaf.id} onDrafted={() => setAutoDraft(null)} />
        ) : (
          <p className="p-8 text-[14px] text-muted-foreground">Pick a use case.</p>
        )}
      </section>
    </div>
  )
}

function UseCaseRow({ item, max, active, fromLoggy, onSelect }: { item: Item; max: number; active: boolean; fromLoggy: boolean; onSelect: () => void }) {
  const { leaf, rank, level } = item
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg px-2 py-2 text-left transition-colors",
          active ? "bg-muted" : "hover:bg-muted/50",
        )}
      >
        <span className={cn("pt-px text-right font-mono text-[12px] tabular-nums", level === "P0" ? "font-semibold text-heat" : "text-muted-foreground")}>{rank}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-medium">{leaf.title}</span>
            {fromLoggy ? <LoggyAvatar size={16} /> : null}
          </span>
          <Bar value={leaf.friction.conversations} max={max} hatched className="mt-1.5 max-w-[180px]" fillClassName="bg-heat/80" />
        </span>
        <span className="font-mono text-[12.5px] text-muted-foreground tabular-nums">{fmtInt(leaf.friction.conversations)}</span>
      </button>
    </li>
  )
}

// ---------------------------------------------------------------- the spec

function Spec({
  index,
  leaf,
  fromLoggy,
  autoDraft,
  onDrafted,
}: {
  index: SnapshotIndex
  leaf: SnapshotNode
  fromLoggy: string | null
  autoDraft: boolean
  onDrafted: () => void
}) {
  const prd = usePrd(index.snapshot.snapshot_id, leaf.id)
  const started = useRef(false)
  useEffect(() => {
    if (!autoDraft || started.current) return
    started.current = true
    onDrafted()
    if (!prd.prd && !prd.busy) prd.request()
  }, [autoDraft, prd, onDrafted])

  const top = (Object.entries(leaf.friction.signals) as [keyof typeof SIGNAL_LABEL, number][]).sort((a, b) => b[1] - a[1])[0]
  const problems = (leaf.problems ?? []).slice(0, 3)
  const liveStage = prd.run?.stages.find((s) => s.status === "running")

  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-8 px-6 py-8">
      <section aria-labelledby="usecase-h">
        {fromLoggy ? (
          <p className="mb-3 flex items-center gap-2 text-[13px] text-muted-foreground">
            <LoggyAvatar size={18} />
            From your question: “{fromLoggy}”
          </p>
        ) : null}
        <h1 id="usecase-h" className="text-[26px] leading-tight font-semibold tracking-tight text-balance">
          {leaf.title}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-pretty text-muted-foreground">{leaf.description}</p>
        <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
          <Fact label="Conversations" value={fmtInt(leaf.conversations)} />
          <Fact label="People" value={fmtInt(leaf.users)} />
          <Fact label="With friction" value={fmtPct(leaf.friction.share)} tone="heat" />
          {top && top[1] > 0 ? (
            <Fact
              label="Most common"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <SignalIcon signal={top[0]} className="size-4" />
                  {SIGNAL_LABEL[top[0]]}
                </span>
              }
              small
            />
          ) : null}
        </dl>
        {problems.length ? (
          <ul className="mt-5 flex flex-col gap-1.5">
            {problems.map((p) => (
              <li key={p.id} className="flex gap-2 text-[14px] leading-snug">
                <SignalIcon signal={p.signal} className="mt-0.5 size-4 text-heat" />
                {p.text}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {prd.prd ? (
        <Drafted prd={prd.prd} leaf={leaf} index={index} />
      ) : (
        <section className="flex flex-col items-start gap-3 rounded-2xl border border-dashed p-6">
          <h2 className="text-[16px] font-semibold">User story and agent prompt</h2>
          <p className="max-w-[560px] text-[14px] leading-snug text-muted-foreground">
            Loggy drafts the story, requirements and a ready-to-paste prompt from this workflow's published needs and problems. Every number comes from the
            verified metrics above.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={prd.request} disabled={prd.busy}>
              {prd.busy ? <LoaderCircle className="animate-spin" /> : prd.error ? <RotateCcw /> : <FileText />}
              {prd.busy ? "Drafting…" : prd.error ? "Try again" : "Draft it"}
            </Button>
            {prd.busy ? (
              <span role="status" className="text-[13px] text-muted-foreground">
                {liveStage?.detail ?? "Starting…"}
              </span>
            ) : null}
          </div>
          {prd.error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {prd.error}
            </p>
          ) : null}
        </section>
      )}
    </div>
  )
}

function Fact({ label, value, tone, small }: { label: string; value: React.ReactNode; tone?: "heat"; small?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className={cn(small ? "mt-1 text-[14px] font-medium" : "font-mono text-[22px] leading-tight font-semibold tabular-nums", tone === "heat" && "text-heat")}>{value}</dd>
    </div>
  )
}

function Drafted({ prd, leaf, index }: { prd: Prd; leaf: SnapshotNode; index: SnapshotIndex }) {
  const prompt = useMemo(() => agentPrompt(prd, leaf, index.snapshot), [prd, leaf, index.snapshot])
  const [copied, setCopied] = useState(false)
  const copy = () =>
    navigator.clipboard.writeText(prompt).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      () => toast.error("Couldn't copy. Use Download instead."),
    )
  const download = () => {
    const url = URL.createObjectURL(new Blob([prdMarkdown(prd, leaf)], { type: "text/markdown" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `prd-${leaf.id}.md`
    a.click()
    URL.revokeObjectURL(url)
  }
  const [story, ...moreStories] = prd.user_stories

  return (
    <>
      <section aria-labelledby="story-h" className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="story-h" className="text-[18px] font-semibold">
            User story
          </h2>
          {prd.priority.level ? (
            <span
              title={prd.priority.basis}
              className={cn("rounded-md px-2 py-0.5 font-mono text-[12px] font-semibold", prd.priority.level === "P0" ? "bg-heat-soft text-heat" : "bg-muted text-muted-foreground")}
            >
              {prd.priority.level}
            </span>
          ) : null}
        </div>
        {story ? <blockquote className="border-l-2 border-brand pl-4 text-[17px] leading-relaxed text-pretty">{stripCitations(story)}</blockquote> : null}
        {moreStories.length ? <List items={moreStories} /> : null}
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">Requirements</h3>
            <List items={prd.requirements} />
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">Done when</h3>
            <List items={prd.success_metrics} />
          </div>
        </div>
      </section>

      <section aria-labelledby="prompt-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="prompt-h" className="text-[18px] font-semibold">
            Prompt for your agent
          </h2>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={download}>
              <Download />
              PRD .md
            </Button>
            <Button size="sm" onClick={copy}>
              {copied ? <Check /> : <ClipboardCopy />}
              {copied ? "Copied" : "Copy prompt"}
            </Button>
          </div>
        </div>
        <pre className="max-h-[420px] overflow-auto rounded-xl border bg-muted/40 px-4 py-3.5 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap">{prompt}</pre>
      </section>
    </>
  )
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[14px] leading-snug marker:text-subtle">
      {items.map((s, i) => (
        <li key={i}>{stripCitations(s)}</li>
      ))}
    </ul>
  )
}
