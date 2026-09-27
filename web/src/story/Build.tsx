import { useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import type { SnapshotIndex } from "@/lib/snapshot"
import { SIGNAL_LABEL } from "@/lib/colors"
import { fmtInt, fmtPct } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Bar, SignalIcon } from "@/components/common"
import { PrdPanel } from "@/components/PrdPanel"
import { roadmap, P0_TOP, P1_TOP, type Item } from "./roadmap"

const LANES = [
  { level: "P0", title: "Now", note: `top ${P0_TOP}` },
  { level: "P1", title: "Next", note: `ranks ${P0_TOP + 1}–${P1_TOP}` },
  { level: "P2", title: "Later", note: "the rest" },
] as const

export function Build({ index }: { index: SnapshotIndex }) {
  const items = useMemo(() => roadmap(index), [index])
  const [selected, setSelected] = useState<string | null>(items[0]?.leaf.id ?? null)
  const [showLater, setShowLater] = useState(false)
  const maxFriction = items[0]?.leaf.friction.conversations ?? 1
  const leaf = selected ? index.byId.get(selected) : undefined

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,50fr)_minmax(0,50fr)]">
      <section aria-label="Roadmap" className="min-h-0 overflow-y-auto rounded-xl border bg-card px-5 py-4">
        <p className="text-[12px] font-medium tracking-wide text-brand uppercase">3 · Build</p>
        <h2 className="mt-1.5 text-[20px] leading-snug font-semibold tracking-[-0.01em] text-balance">
          From findings to a roadmap the engineering team can start on.
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-snug text-muted-foreground">
          Ranked by conversations with an observed friction signal, from published counts. No model decides the order. Open any row for a PRD whose
          every number is filled from verified metrics.
        </p>

        <div className="mt-4 flex flex-col gap-4">
          {LANES.map((lane) => {
            const laneItems = items.filter((it) => it.level === lane.level)
            if (!laneItems.length) return null
            const collapsed = lane.level === "P2" && !showLater
            return (
              <div key={lane.level}>
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className={cn("rounded-md px-1.5 py-px font-mono text-[11px] font-semibold", lane.level === "P0" ? "bg-heat-soft text-heat" : "bg-muted text-muted-foreground")}>
                    {lane.level}
                  </span>
                  <span className="text-[13.5px] font-semibold">{lane.title}</span>
                  <span className="text-[12px] text-muted-foreground">
                    {lane.note} · {laneItems.length} workflows
                  </span>
                  {lane.level === "P2" ? (
                    <button type="button" className="ml-auto text-[12px] font-medium text-brand hover:underline" onClick={() => setShowLater((v) => !v)}>
                      {showLater ? "Hide" : "Show"}
                    </button>
                  ) : null}
                </div>
                {collapsed ? null : (
                  <ul className="flex flex-col gap-1">
                    {laneItems.map((it) => (
                      <RoadmapRow key={it.leaf.id} item={it} max={maxFriction} active={selected === it.leaf.id} onSelect={() => setSelected(it.leaf.id)} />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <aside aria-label="PRD" className="min-h-0 overflow-y-auto rounded-xl border bg-card px-5 py-4">
        {leaf && leaf.level === 2 ? (
          <div key={leaf.id} className="flex flex-col gap-3">
            <div>
              <p className="text-[12px] text-muted-foreground">Workflow</p>
              <h3 className="text-[16px] font-semibold text-balance">{leaf.title}</h3>
              <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{leaf.description}</p>
            </div>
            <PrdPanel index={index} leaf={leaf} onHoverCitation={() => {}} />
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">Select a workflow to draft its PRD.</p>
        )}
      </aside>
    </div>
  )
}

function RoadmapRow({ item, max, active, onSelect }: { item: Item; max: number; active: boolean; onSelect: () => void }) {
  const { leaf, rank, top } = item
  const problem = leaf.problems?.find((p) => p.support === "common") ?? leaf.problems?.[0]
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "group grid w-full grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
          active ? "border-foreground/30 bg-muted/60" : "border-transparent hover:bg-muted/40",
        )}
      >
        <span className="pt-px text-right font-mono text-[12px] text-muted-foreground tabular-nums">{rank}</span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-medium">{leaf.title}</span>
          {problem ? <span className="mt-0.5 line-clamp-1 block text-[12px] text-muted-foreground">{problem.text}</span> : null}
          <span className="mt-1.5 flex items-center gap-2">
            <Bar value={leaf.friction.conversations} max={max} hatched className="max-w-[160px]" fillClassName="bg-heat/80" />
            {top ? (
              <span className="inline-flex items-center gap-1 text-[11.5px] whitespace-nowrap text-muted-foreground">
                <SignalIcon signal={top} className="size-3" />
                {SIGNAL_LABEL[top]}
              </span>
            ) : null}
          </span>
        </span>
        <span className="flex items-center gap-1 text-right">
          <span className="flex flex-col items-end">
            <span className="font-mono text-[13px] font-semibold tabular-nums">{fmtInt(leaf.friction.conversations)}</span>
            <span className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
              {fmtPct(leaf.friction.share)} of {fmtInt(leaf.conversations)} · {fmtInt(leaf.users)} ppl
            </span>
          </span>
          <ChevronRight aria-hidden className={cn("size-4 text-muted-foreground transition-opacity", active ? "opacity-100" : "opacity-0 group-hover:opacity-60")} />
        </span>
      </button>
    </li>
  )
}
