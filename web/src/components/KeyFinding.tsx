import { useMemo } from "react"
import { ArrowRight, Flame } from "lucide-react"
import type { SnapshotIndex } from "@/lib/snapshot"
import { FINDING_MIN_LEAF_CONVERSATIONS, keyFindings } from "@/lib/findings"
import { proseName } from "@/lib/labels"
import { fmtInt, fmtPct } from "@/lib/format"
import { Button } from "@/components/ui/button"

/**
 * The first thing to read: which category is over-represented in observed
 * friction, computed from the published snapshot, with a one-click path to the
 * workflow where it breaks.
 */
export function KeyFinding({
  index,
  onShow,
  onSelectLeaf,
}: {
  index: SnapshotIndex
  onShow: (categoryId: string, leafId: string | null) => void
  onSelectLeaf: (id: string) => void
}) {
  const { friction, concentration } = useMemo(() => keyFindings(index.snapshot), [index.snapshot])
  if (!friction) return null
  const cat = friction.category
  const leaf = friction.leaf
  const max = Math.max(friction.conversationShare, friction.frictionShare)
  const pal = index.paletteOf(cat.id)
  return (
    <section aria-labelledby="finding-h" className="rounded-xl border border-heat/25 bg-heat-soft/70 p-4">
      <h2 id="finding-h" className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.07em] text-heat uppercase">
        <Flame aria-hidden className="size-3.5" />
        Key finding
      </h2>
      <p className="mt-1.5 text-[17px] leading-snug font-semibold tracking-[-0.01em] text-balance">
        {proseName(cat)} is {fmtPct(friction.conversationShare)} of conversations but {fmtPct(friction.frictionShare)} of observed friction.
      </p>

      <dl className="mt-3 grid grid-cols-[6.5rem_1fr_3.25rem] items-center gap-x-2.5 gap-y-1.5 text-[12px]">
        <dt className="text-muted-foreground">Conversations</dt>
        <dd aria-hidden className="h-2 overflow-hidden rounded-full bg-card/80">
          <div className="h-full rounded-full" style={{ width: `${(friction.conversationShare / max) * 100}%`, background: pal.dot }} />
        </dd>
        <dd className="text-right font-mono tabular-nums">{fmtPct(friction.conversationShare)}</dd>
        <dt className="text-muted-foreground">Friction</dt>
        <dd aria-hidden className="h-2 overflow-hidden rounded-full bg-card/80">
          <div className="hatch-bg h-full rounded-full bg-heat/40" style={{ width: `${(friction.frictionShare / max) * 100}%` }} />
        </dd>
        <dd className="text-right font-mono font-semibold tabular-nums">{fmtPct(friction.frictionShare)}</dd>
      </dl>

      {leaf ? (
        <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button size="sm" onClick={() => onShow(cat.id, leaf.id)}>
            Show where it breaks
            <ArrowRight data-icon="inline-end" />
          </Button>
          <span className="text-[12px] text-muted-foreground">
            {proseName(leaf)} · <span className="font-mono text-foreground tabular-nums">{fmtPct(leaf.friction.share)}</span> friction
          </span>
        </div>
      ) : null}
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        {fmtInt(cat.friction.conversations)} of {fmtInt(index.snapshot.totals.friction.conversations)} conversations with an observed friction signal.
        {leaf
          ? friction.leafMeetsMinimum
            ? ` Opens its highest friction rate among workflows with ≥ ${FINDING_MIN_LEAF_CONVERSATIONS} conversations.`
            : ` Opens its highest friction rate (no workflow there has ${FINDING_MIN_LEAF_CONVERSATIONS}+ conversations).`
          : ""}{" "}
        Other or unclear is not a candidate.
      </p>

      {concentration ? (
        <button
          type="button"
          onClick={() => onSelectLeaf(concentration.leaf.id)}
          className="mt-3 w-full border-t border-heat/20 pt-2.5 text-left text-[12.5px] leading-snug transition-colors hover:text-foreground"
        >
          <span className="font-medium">{proseName(concentration.leaf)}</span>
          <span className="text-muted-foreground">
            : {fmtInt(concentration.leaf.conversations)} conversations from {fmtInt(concentration.leaf.users)} people (≈ {concentration.ratio.toFixed(1)} each).
          </span>
        </button>
      ) : null}
    </section>
  )
}
