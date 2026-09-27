import { useMemo, useState } from "react"
import { ArrowDown, ArrowUp, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Node as SnapshotNode } from "@/lib/types"
import type { SnapshotIndex } from "@/lib/snapshot"
import { leafEmphasis, type HighlightState } from "@/lib/search"
import { fmtInt, fmtPct } from "@/lib/format"
import { FRICTION_MAX } from "@/lib/colors"
import { Bar, Dot } from "./common"
import type { Lens } from "./UsageMap"

type SortKey = "conversations" | "users" | "friction" | "title"

const value = (n: SnapshotNode, k: SortKey): number | string =>
  k === "title" ? n.title : k === "users" ? n.users : k === "friction" ? (n.friction.share ?? -1) : n.conversations

export function ClusterList({
  index,
  lens,
  highlight,
  selectedId,
  focusId,
  onSelectLeaf,
}: {
  index: SnapshotIndex
  lens: Lens
  highlight: HighlightState
  selectedId: string | null
  focusId: string | null
  onSelectLeaf: (id: string) => void
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null)
  const effective = sort ?? { key: lens === "friction" ? "friction" : "conversations", dir: -1 as const }

  const rows = useMemo(() => {
    const base = focusId ? index.leavesOf(focusId) : index.leaves
    return [...base].sort((a, b) => {
      const va = value(a, effective.key)
      const vb = value(b, effective.key)
      const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number)
      return c * effective.dir || a.id.localeCompare(b.id)
    })
  }, [index, focusId, effective.key, effective.dir])

  const maxConv = Math.max(1, ...rows.map((r) => r.conversations))

  const header = (key: SortKey, label: string, align: "left" | "right" = "right") => {
    const active = effective.key === key
    const Icon = effective.dir === -1 ? ArrowDown : ArrowUp
    return (
      <th scope="col" aria-sort={active ? (effective.dir === -1 ? "descending" : "ascending") : "none"} className={cn("px-2 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          onClick={() => setSort({ key, dir: active ? (effective.dir === -1 ? 1 : -1) : key === "title" ? 1 : -1 })}
          className={cn("inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground", active && "text-foreground")}
        >
          {label}
          {active ? <Icon aria-hidden className="size-3" /> : null}
        </button>
      </th>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">
          Workflow clusters{focusId ? ` in ${index.titleOf(focusId)}` : ""}, sorted by {effective.key}. Select a row to see its details.
        </caption>
        <thead className="sticky top-0 z-10 bg-card/95 text-[11px] tracking-[0.04em] text-muted-foreground uppercase backdrop-blur-sm [&_th]:border-b">
          <tr>
            {header("title", "Workflow", "left")}
            {header("conversations", "Conversations")}
            {header("users", "People")}
            {header("friction", "Friction")}
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const em = leafEmphasis(highlight, n.id)
            const pal = index.paletteOf(n.id)
            const selected = selectedId === n.id
            return (
              <tr
                key={n.id}
                className={cn(
                  "transition-opacity duration-150 [&>td]:border-b [&>td]:border-border/60",
                  em === "dim" && "opacity-35",
                  em === "partial" && "opacity-75",
                  selected && "bg-muted",
                )}
              >
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => onSelectLeaf(n.id)}
                    aria-pressed={selected}
                    className="flex w-full min-w-0 items-center gap-2 rounded-sm py-0.5 text-left"
                  >
                    <Dot color={pal.dot} />
                    <span className={cn("truncate", em === "match" && "font-medium", em === "partial" && "underline decoration-dashed underline-offset-4")}>{n.title}</span>
                    {n.surprising?.flag ? <Sparkles aria-label="Surprising" className="size-3 shrink-0 text-brand" /> : null}
                  </button>
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center justify-end gap-2">
                    <Bar value={n.conversations} max={maxConv} className="hidden h-1 w-16 sm:block" fillClassName="bg-foreground/35" />
                    <span className="w-12 text-right font-mono tabular-nums">{fmtInt(n.conversations)}</span>
                  </div>
                </td>
                <td className={cn("px-2 py-1.5 text-right font-mono tabular-nums", n.users * 3 <= n.conversations && "font-medium text-brand")}>{fmtInt(n.users)}</td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center justify-end gap-2">
                    <Bar value={Math.min(n.friction.share ?? 0, FRICTION_MAX)} max={FRICTION_MAX} className="hidden h-1 w-12 sm:block" hatched fillClassName="bg-heat/30" />
                    <span className={cn("w-12 text-right font-mono tabular-nums", lens === "friction" && "font-medium")}>{fmtPct(n.friction.share)}</span>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
