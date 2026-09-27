import { useState } from "react"
import { ArrowUpRight, Sparkles, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Node as SnapshotNode } from "@/lib/types"
import { SIGNALS } from "@/lib/types"
import type { SnapshotIndex } from "@/lib/snapshot"
import { orderedLanguages } from "@/lib/snapshot"
import { SIGNAL_HINT, SIGNAL_LABEL, signalName } from "@/lib/colors"
import { fmtInt, fmtPct } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Bar, Dot, EvidenceTag, Hint, SectionLabel, SignalIcon, Stat } from "./common"
import { StoryPanel } from "./StoryPanel"
import { KeyFinding } from "./KeyFinding"

import { PEOPLE_HINT, fixtureCount, fixturesShort } from "@/lib/copy"
const FRICTION_HINT = "Conversations where at least one friction signal was observed, out of all conversations in this cluster."
const UNCLEAR_HINT = "No signal observed, but at least one signal decision was below the confidence cut-off, so it is counted as unclear rather than guessed."

type Props = {
  index: SnapshotIndex
  selectedId: string | null
  focusId: string | null
  onSelectLeaf: (id: string | null) => void
  onFocusCategory: (id: string | null) => void
  /** zoom into a category and open its workflow where friction concentrates */
  onShowFinding?: (categoryId: string, leafId: string | null) => void
  /** ask the agent a question (example chips on the first screen) */
  onAsk?: (question: string) => void
}

export function DetailPanel({ index, selectedId, focusId, onSelectLeaf, onFocusCategory, onShowFinding, onAsk }: Props) {
  const leaf = selectedId ? index.byId.get(selectedId) : undefined
  if (leaf && leaf.level === 2) {
    return <LeafDetail key={`${index.snapshot.snapshot_id}:${leaf.id}`} index={index} leaf={leaf} onClose={() => onSelectLeaf(null)} onFocusCategory={onFocusCategory} />
  }
  const cat = focusId ? index.byId.get(focusId) : undefined
  return (
    <Overview
      index={index}
      category={cat && cat.level === 1 ? cat : undefined}
      onSelectLeaf={onSelectLeaf}
      onFocusCategory={onFocusCategory}
      onShowFinding={onShowFinding}
      onAsk={onAsk}
    />
  )
}

// ---------------------------------------------------------------- leaf

function LeafDetail({
  index,
  leaf,
  onClose,
  onFocusCategory,
}: {
  index: SnapshotIndex
  leaf: SnapshotNode
  onClose: () => void
  onFocusCategory: (id: string | null) => void
}) {
  const parent = index.parentOf(leaf.id)
  const pal = index.paletteOf(leaf.id)
  const total = index.snapshot.totals.conversations
  const perPerson = leaf.users > 0 ? leaf.conversations / leaf.users : null
  const concentrated = perPerson !== null && perPerson >= 3
  const [activeEvidence, setActiveEvidence] = useState<string | null>(null)
  const maxSignal = Math.max(1, ...SIGNALS.map((s) => leaf.friction.signals[s]))

  return (
    <article aria-labelledby="detail-title" className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          {parent ? (
            <button
              type="button"
              onClick={() => onFocusCategory(parent.id)}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <Dot color={pal.dot} />
              <span className="truncate">{parent.title}</span>
            </button>
          ) : (
            <span />
          )}
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Clear selection">
            <X />
          </Button>
        </div>
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
          <h2 id="detail-title" className="text-[19px] leading-tight font-semibold tracking-[-0.01em] text-balance">
            {leaf.title}
          </h2>
          {leaf.surprising?.flag ? (
            <Hint
              label={
                <span>
                  Scored against the intended-use list: {index.snapshot.intended_uses.join("; ")}. Score{" "}
                  <span className="font-mono">{leaf.surprising.score.toFixed(2)}</span>.
                </span>
              }
            >
              <button type="button" className="mt-0.5 rounded-full">
                <Badge variant="outline" className="border-brand/30 bg-brand-soft text-brand">
                  <Sparkles data-icon="inline-start" />
                  Surprising
                </Badge>
              </button>
            </Hint>
          ) : null}
          {leaf.is_other ? (
            <Badge variant="outline" className="mt-0.5 text-muted-foreground">
              Catch-all
            </Badge>
          ) : null}
        </div>
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">{leaf.description}</p>
      </header>

      {/* stats: conversations and people side by side, equal weight */}
      <section aria-label="Key numbers" className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-xl border bg-muted/40 p-4">
        <Stat label="Conversations" value={fmtInt(leaf.conversations)} sub={`${fmtPct(total ? leaf.conversations / total : null)} of all ${fmtInt(total)}`} />
        <Stat
          label="People"
          hint={PEOPLE_HINT}
          value={fmtInt(leaf.users)}
          emphasis={concentrated}
          sub={
            perPerson === null ? (
              "unavailable"
            ) : concentrated ? (
              <span className="font-medium text-brand">≈ {perPerson.toFixed(1)} conversations each — a few heavy users</span>
            ) : (
              `≈ ${perPerson.toFixed(1)} conversations each`
            )
          }
        />
        <Stat
          label="Friction"
          hint={FRICTION_HINT}
          value={fmtPct(leaf.friction.share)}
          sub={leaf.friction.share === null ? "unavailable" : `${fmtInt(leaf.friction.conversations)} of ${fmtInt(leaf.conversations)}`}
        />
        <Stat label="Unclear" hint={UNCLEAR_HINT} value={fmtInt(leaf.friction.unclear)} sub={`${fmtPct(leaf.conversations ? leaf.friction.unclear / leaf.conversations : null)} · not counted as friction`} />
      </section>

      <section aria-labelledby="signals-h">
        <SectionLabel aside="Signals overlap">
          <span id="signals-h">Friction signals</span>
        </SectionLabel>
        <ul className="flex flex-col gap-2">
          {SIGNALS.map((s) => {
            const n = leaf.friction.signals[s]
            return (
              <li key={s} className="grid grid-cols-[9.5rem_1fr_4.5rem] items-center gap-3 text-[13px]">
                <Hint label={SIGNAL_HINT[s]} side="left">
                  <span className="inline-flex w-fit cursor-help items-center gap-1.5 text-foreground/85">
                    <SignalIcon signal={s} className="text-muted-foreground" />
                    {SIGNAL_LABEL[s]}
                  </span>
                </Hint>
                <Bar value={n} max={maxSignal} fillClassName="bg-heat/75" />
                <span className="text-right font-mono text-[12px] tabular-nums">
                  {fmtInt(n)}
                  <span className="text-muted-foreground"> · {fmtPct(leaf.conversations ? n / leaf.conversations : null)}</span>
                </span>
              </li>
            )
          })}
        </ul>
        <p className="mt-2 text-[11.5px] text-muted-foreground">A conversation can show several signals, so these don't add up to the friction total.</p>
      </section>

      <section aria-labelledby="langs-h">
        <SectionLabel>
          <span id="langs-h">Top languages</span>
        </SectionLabel>
        <ul className="flex flex-wrap gap-1.5">
          {orderedLanguages(leaf.languages).map((l) => {
            const other = /^other/i.test(l.name)
            return (
              <li
                key={l.name}
                className={cn(
                  "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px]",
                  other ? "border-dashed text-muted-foreground" : "bg-card",
                )}
              >
                {l.name}
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{fmtInt(l.conversations)}</span>
              </li>
            )
          })}
        </ul>
      </section>

      <Separator />

      <section aria-labelledby="needs-h">
        <SectionLabel>
          <span id="needs-h">What people need</span>
        </SectionLabel>
        <ul className="flex flex-col gap-2">
          {(leaf.needs ?? []).map((n) => (
            <li
              key={n.id}
              className={cn("flex items-start gap-2.5 rounded-md text-[13.5px] leading-snug transition-colors", activeEvidence === n.id && "bg-brand-soft/70")}
            >
              <EvidenceTag id={n.id} active={activeEvidence === n.id} className="mt-0.5" />
              <span>{n.text}</span>
            </li>
          ))}
          {(leaf.needs ?? []).length === 0 ? <li className="text-[13px] text-muted-foreground">No generalized needs published for this cluster.</li> : null}
        </ul>
      </section>

      <section aria-labelledby="problems-h">
        <SectionLabel aside={<span className="italic">lighter = an observed request (&lt; 5 people)</span>}>
          <span id="problems-h">Where it breaks</span>
        </SectionLabel>
        <ul className="flex flex-col gap-2">
          {(leaf.problems ?? []).map((p) => {
            const observed = p.support === "observed"
            return (
              <li
                key={p.id}
                className={cn("flex items-start gap-2.5 rounded-md text-[13.5px] leading-snug transition-colors", activeEvidence === p.id && "bg-brand-soft/70")}
              >
                <EvidenceTag id={p.id} active={activeEvidence === p.id} className="mt-0.5" />
                <Hint label={signalName(p.signal)} side="left">
                  <span className="mt-0.5 inline-flex" aria-label={signalName(p.signal)}>
                    <SignalIcon signal={p.signal} className={observed ? "text-subtle" : "text-heat"} />
                  </span>
                </Hint>
                <span className={cn(observed && "text-muted-foreground")}>
                  {p.text}
                  {observed ? <span className="ml-1.5 text-[11.5px] whitespace-nowrap text-subtle italic">an observed request</span> : null}
                </span>
              </li>
            )
          })}
          {(leaf.problems ?? []).length === 0 ? <li className="text-[13px] text-muted-foreground">No problems published for this cluster.</li> : null}
        </ul>
      </section>

      <StoryPanel index={index} leaf={leaf} onHoverCitation={setActiveEvidence} />
    </article>
  )
}

// ---------------------------------------------------------------- overview

function Overview({
  index,
  category,
  onSelectLeaf,
  onFocusCategory,
  onShowFinding,
  onAsk,
}: {
  index: SnapshotIndex
  category?: SnapshotNode
  onSelectLeaf: (id: string | null) => void
  onFocusCategory: (id: string | null) => void
  onShowFinding?: (categoryId: string, leafId: string | null) => void
  onAsk?: (question: string) => void
}) {
  const s = index.snapshot
  const node = category ?? { ...s.totals, title: "All conversations", description: s.workspace.description }
  const total = s.totals.conversations
  const rows = category ? index.leavesOf(category.id) : index.categories
  const max = Math.max(1, ...rows.map((r) => r.conversations))
  const pal = category ? index.paletteOf(category.id) : null

  return (
    <article aria-labelledby="overview-title" className="flex flex-col gap-5">
      {!category && onShowFinding ? <KeyFinding index={index} onShow={onShowFinding} onSelectLeaf={(id) => onSelectLeaf(id)} onAsk={onAsk} /> : null}
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {category ? (
            <>
              <Dot color={pal!.dot} />
              Category
            </>
          ) : (
            "Overview"
          )}
        </div>
        <h2 id="overview-title" className="text-[19px] leading-tight font-semibold tracking-[-0.01em]">
          {node.title}
        </h2>
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">{"description" in node ? node.description : ""}</p>
      </header>

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-4 rounded-xl border bg-muted/40 p-4 sm:grid-cols-3">
        <Stat
          label="Conversations"
          value={fmtInt(node.conversations)}
          sub={
            category ? (
              `${fmtPct(node.conversations / total)} of all`
            ) : (
              <>
                {fmtInt(s.dataset.languages)} languages
                {fixtureCount(s.dataset.fixtures) ? (
                  <span className="block text-[11.5px] text-subtle">
                    {fmtInt(node.conversations - fixtureCount(s.dataset.fixtures))} {s.dataset.name} + {fixturesShort(s.dataset.fixtures)}
                  </span>
                ) : null}
              </>
            )
          }
        />
        <Stat label="People" hint={PEOPLE_HINT} value={fmtInt(node.users)} sub={node.users ? `≈ ${(node.conversations / node.users).toFixed(1)} each` : "unavailable"} />
        <Stat label="Friction" hint={FRICTION_HINT} value={fmtPct(node.friction.share)} sub={`${fmtInt(node.friction.conversations)} of ${fmtInt(node.conversations)}`} />
      </section>

      <section aria-labelledby="ov-list-h">
        <SectionLabel aside={category ? `${rows.length} workflows` : `${rows.length} categories`}>
          <span id="ov-list-h">{category ? "Workflows in this category" : "Top categories"}</span>
        </SectionLabel>
        <ul className="flex flex-col">
          {rows.map((r) => {
            const rp = index.paletteOf(r.id)
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => (category ? onSelectLeaf(r.id) : onFocusCategory(r.id))}
                  className="group grid w-full grid-cols-1 items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted sm:grid-cols-[1fr_auto]"
                >
                  <span className="flex min-w-0 items-center gap-2 text-[13.5px]">
                    <Dot color={rp.dot} />
                    <span className="truncate">{r.title}</span>
                    {r.surprising?.flag ? <Sparkles aria-label="Surprising" className="size-3 shrink-0 text-brand" /> : null}
                  </span>
                  <span className="pl-4 font-mono text-[12px] text-muted-foreground tabular-nums sm:pl-0">
                    <span className="text-foreground">{fmtInt(r.conversations)}</span> · {fmtInt(r.users)} ppl · {fmtPct(r.friction.share)}
                  </span>
                  <Bar value={r.conversations} max={max} className="ml-4 h-1 sm:col-span-2" fillClassName="bg-foreground/35 group-hover:bg-foreground/55" />
                </button>
              </li>
            )
          })}
        </ul>
        <p className="mt-2 px-2 text-[11px] text-muted-foreground">Conversations · people · friction share</p>
      </section>

      <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-[13px] text-muted-foreground">
        <ArrowUpRight aria-hidden className="size-4 shrink-0" />
        Select a workflow to see its needs and friction.
      </div>
    </article>
  )
}
