import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useElementSize } from "@/hooks/useElementSize"
import { layoutOrderOf, packLayout, zoomTransform, type PackedCircle } from "@/lib/hierarchy"
import type { Snapshot } from "@/lib/types"
import type { IntakeVisual } from "@/hooks/useIntake"
import { useLayoutTween } from "@/hooks/useLayoutTween"
import { IntakeOverlay } from "./IntakeOverlay"
import { arcLabelFits, canvasMeasure, ellipsizeLabel, fitCircleLabel, labelText, resetMeasureCache, type CircleLabel } from "@/lib/labels"
import { categoryEmphasis, leafEmphasis, type Emphasis, type HighlightState } from "@/lib/search"
import type { SnapshotIndex } from "@/lib/snapshot"
import { FRICTION_LEGEND, FRICTION_MAX, frictionFill, frictionLabelColor, frictionRingWidth, frictionStroke } from "@/lib/colors"
import { fmtInt, fmtPct } from "@/lib/format"

export type Lens = "usage" | "friction"

type Props = {
  index: SnapshotIndex
  lens: Lens
  highlight: HighlightState
  selectedId: string | null
  focusId: string | null
  peekId?: string | null
  onSelectLeaf: (id: string | null) => void
  onFocusCategory: (id: string | null) => void
  onLens: (lens: Lens) => void
  /** snapshot whose packing order and rotation later snapshots keep (stable updates) */
  layoutBase?: Snapshot | null
  /** conversations filed live but not yet in the snapshot (intake), per leaf */
  liveDelta?: Map<string, number>
  /** live intake stream to animate over the map */
  intake?: { visual: IntakeVisual; decided: number; total: number } | null
  /** extra control in the map header (presenter-only live intake) */
  headerControl?: ReactNode
}

const PACK = { categoryPadding: 14, leafPadding: 3, categoryBand: 16, margin: 6 }

const CAT_FONT = 10.5
const CAT_TRACKING = 0.9
const CAT_BAND = 16 // px between a category rim and its leaves; holds the curved label
const LEAF_MIN_LABEL_R = 22 // every leaf at least this big (on screen) gets a label
const KEY_BELOW_WIDTH = 560 // narrower maps get a category key instead of straight labels

type CategoryLabel =
  | { mode: "arc"; text: string; fontSize: number }
  | { mode: "outside"; text: string; fontSize: number; x: number; y: number }

const OPACITY: Record<Emphasis, number> = { none: 1, match: 1, partial: 0.62, dim: 0.14 }

export function UsageMap({
  index,
  lens,
  highlight,
  selectedId,
  focusId,
  peekId,
  onSelectLeaf,
  onFocusCategory,
  onLens,
  layoutBase,
  liveDelta,
  intake,
  headerControl,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(boxRef)
  const [hover, setHover] = useState<string | null>(null)

  // Layout depends only on the snapshot and the container size. Updates keep
  // the base snapshot's packing order and rotation so circles grow in place.
  const base = layoutBase ?? index.snapshot
  const order = useMemo(() => layoutOrderOf(base), [base])
  const baseAngle = useMemo(() => (width > 40 && height > 40 ? packLayout(base, width, height, PACK).angle : 0), [base, width, height])
  const target = useMemo(
    () => (width > 40 && height > 40 ? packLayout(index.snapshot, width, height, { ...PACK, order, angle: baseAngle }) : null),
    [index.snapshot, width, height, order, baseAngle],
  )
  const [reduceMotion] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  const layout = useLayoutTween(target, 600, reduceMotion)

  const focus = focusId && layout ? layout.byId.get(focusId) ?? null : null
  const { k, tx, ty } = zoomTransform(focus, width, height, 0.92)

  // Intake overlay geometry: final (untweened) circle positions in screen space.
  const targetOf = useCallback(
    (leafId: string) => {
      const c = target?.byId.get(leafId)
      return c ? { x: c.x * k + tx, y: c.y * k + ty, r: c.r * k } : null
    },
    [target, k, tx, ty],
  )
  const obstacles = useMemo(() => (target ? target.categories.map((c) => ({ x: c.x * k + tx, y: c.y * k + ty, r: c.r * k })) : []), [target, k, tx, ty])
  const colorOf = useCallback(
    (leafId: string) => {
      const pal = index.paletteOf(leafId)
      return { dot: pal.dot, ring: pal.label }
    },
    [index],
  )

  // Re-measure labels once the web font has loaded (canvas widths change).
  const [fontsReady, setFontsReady] = useState(0)
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? document.fonts : undefined
    if (!fonts) return
    let alive = true
    fonts.ready.then(() => {
      if (!alive) return
      resetMeasureCache()
      setFontsReady((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [])

  // Label placement: depends on layout + zoom, never on lens/search/selection.
  const labels = useMemo(() => {
    void fontsReady
    if (!layout) return null
    const leaf = new Map<string, CircleLabel | null>()
    for (const l of layout.leaves) {
      const rs = l.r * k
      const text = labelText(l.node)
      let fit = rs >= 12 ? fitCircleLabel(text, rs, { maxFont: 13, minFont: 10, maxLines: 3, subLine: true, measure: canvasMeasure }) : null
      if (!fit && rs >= LEAF_MIN_LABEL_R) fit = fitCircleLabel(text, rs, { maxFont: 11, minFont: 10, maxLines: 4, measure: canvasMeasure })
      if (!fit && rs >= LEAF_MIN_LABEL_R) fit = ellipsizeLabel(text, rs, 10, canvasMeasure)
      leaf.set(l.id, fit)
    }
    const cat = new Map<string, CategoryLabel>()
    const placed: { x: number; y: number; w: number; h: number }[] = []
    // Larger categories claim label space first.
    for (const c of [...layout.categories].sort((a, b) => b.r - a.r)) {
      const text = labelText(c.node)
      const labelR = (c.r - CAT_BAND / 2 + 0.5) * k
      const arcFont = [CAT_FONT, 9.5].find((f) => arcLabelFits(text, labelR, f, CAT_TRACKING, canvasMeasure))
      if (arcFont) {
        cat.set(c.id, { mode: "arc", text: text.toUpperCase(), fontSize: arcFont })
        continue
      }
      // Narrow maps show a category key instead of crowded straight labels.
      if (width < KEY_BELOW_WIDTH) continue
      // Too small for a curved label: a straight label just outside the rim.
      // Try below/above (centred and nudged sideways) and keep the candidate
      // that stays on screen and overlaps other category circles the least.
      const fs = 11
      const w = canvasMeasure(text, fs, 560) + 6
      const h = fs + 4
      const sx = c.x * k + tx
      const sy = c.y * k + ty
      const sr = c.r * k
      const others = layout.categories.filter((o) => o.id !== c.id).map((o) => ({ x: o.x * k + tx, y: o.y * k + ty, r: o.r * k }))
      const overlap = (cx: number, cy: number) => {
        let score = 0
        for (const p of placed) {
          if (Math.abs(cx - p.x) * 2 < w + p.w && Math.abs(cy - p.y) * 2 < h + p.h) score += 1000
        }
        for (const o of others) {
          const nx = Math.max(cx - w / 2, Math.min(o.x, cx + w / 2))
          const ny = Math.max(cy - h / 2, Math.min(o.y, cy + h / 2))
          const d = Math.hypot(o.x - nx, o.y - ny)
          if (d < o.r) score += o.r - d
        }
        return score
      }
      let best: { x: number; y: number; score: number } | null = null
      for (const dy of [sr + h / 2 + 2, -(sr + h / 2 + 2)]) {
        for (const shift of [0, -0.25, 0.25, -0.45, 0.45]) {
          const cy = sy + dy
          if (cy - h / 2 < 2 || cy + h / 2 > height - 2) continue
          const cx = Math.min(Math.max(sx + shift * w, w / 2 + 4), width - w / 2 - 4)
          const score = overlap(cx, cy) + Math.abs(shift) * 2
          if (!best || score < best.score) best = { x: cx, y: cy, score }
        }
      }
      // No clean spot (it would cover another label): leave it to the key/tooltip.
      if (!best || best.score >= 1000) continue
      placed.push({ x: best.x, y: best.y, w, h })
      cat.set(c.id, { mode: "outside", text, fontSize: fs, x: (best.x - tx) / k, y: (best.y - ty) / k })
    }
    return { leaf, cat }
  }, [layout, k, tx, ty, width, height, fontsReady])

  const onKey = useCallback((e: KeyboardEvent, fn: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      fn()
    }
  }, [])

  const handleLeaf = (leaf: PackedCircle) => {
    if (focusId && leaf.parentId !== focusId) onFocusCategory(leaf.parentId)
    onSelectLeaf(leaf.id)
  }

  const handleCategory = (cat: PackedCircle) => {
    if (focusId === cat.id) {
      onSelectLeaf(null)
      return
    }
    onSelectLeaf(null)
    onFocusCategory(cat.id)
  }

  const total = index.snapshot.totals.conversations
  const hovered = hover && layout ? layout.byId.get(hover) ?? null : null
  const focusNode = focusId ? index.byId.get(focusId) : null

  return (
    <div
      className="flex h-full w-full flex-col select-none lg:min-h-[420px]"
      onKeyDown={(e) => {
        if (e.key === "Escape" && focusId) {
          e.stopPropagation()
          onFocusCategory(null)
        }
      }}
    >
      <MapBar index={index} focusNode={focusNode ?? null} onFocusCategory={onFocusCategory} lens={lens} onLens={onLens} extra={headerControl} />
      <div ref={boxRef} className="relative aspect-square min-h-0 w-full overflow-hidden lg:aspect-auto lg:flex-1">
      {layout ? (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block"
          role="group"
          aria-label={`Usage map. ${index.leaves.length} workflow clusters in ${index.categories.length} categories; circle area is proportional to conversations. Use the list view for a table.`}
        >
          <rect
            width={width}
            height={height}
            fill="transparent"
            onClick={() => {
              if (focusId) onFocusCategory(null)
              else onSelectLeaf(null)
            }}
          />
          <g className="map-zoom" style={{ transform: `translate(${tx}px, ${ty}px) scale(${k})` }}>
            {layout.categories.map((c) => {
              const pal = index.palette.get(c.id)!
              const em = categoryEmphasis(highlight, c.id)
              const outOfFocus = !!focusId && focusId !== c.id
              const node = c.node
              const labelR = c.r - CAT_BAND / 2 + 0.5
              const catLabel = labels?.cat.get(c.id) ?? null
              const friction = lens === "friction"
              return (
                <g
                  key={c.id}
                  className="map-node map-anim"
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.title} category: ${fmtInt(node.conversations)} conversations, ${fmtInt(node.users)} people, friction ${fmtPct(node.friction.share)}. ${focusId === c.id ? "Focused." : "Press Enter to focus."}`}
                  aria-pressed={focusId === c.id}
                  style={{ opacity: outOfFocus ? 0.28 : em === "dim" ? 0.4 : 1 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCategory(c)
                  }}
                  onKeyDown={(e) => onKey(e, () => handleCategory(c))}
                  onMouseEnter={() => setHover(c.id)}
                  onMouseLeave={() => setHover((h) => (h === c.id ? null : h))}
                  onFocus={() => setHover(c.id)}
                  onBlur={() => setHover((h) => (h === c.id ? null : h))}
                >
                  <circle className="focus-ring" cx={c.x} cy={c.y} r={c.r + 3 / k} fill="none" stroke="var(--ring)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  <circle
                    className="map-anim"
                    cx={c.x}
                    cy={c.y}
                    r={c.r}
                    fill={friction ? "oklch(0.988 0.001 95)" : pal.fill}
                    stroke={friction ? "oklch(0.86 0.003 95)" : hover === c.id ? pal.leafStroke : pal.stroke}
                    strokeWidth={focusId === c.id ? 1.5 : 1}
                    vectorEffect="non-scaling-stroke"
                  />
                  {catLabel?.mode === "arc" && !outOfFocus ? (
                    <>
                      <path id={`arc-${c.id}`} d={`M ${c.x - labelR} ${c.y} A ${labelR} ${labelR} 0 0 1 ${c.x + labelR} ${c.y}`} fill="none" />
                      <text
                        fontSize={catLabel.fontSize / k}
                        fontWeight={560}
                        letterSpacing={`${CAT_TRACKING / k}px`}
                        fill={friction ? "oklch(0.45 0.008 285)" : pal.label}
                        dominantBaseline="central"
                        style={{ pointerEvents: "none" }}
                      >
                        <textPath href={`#arc-${c.id}`} startOffset="50%" textAnchor="middle">
                          {catLabel.text}
                        </textPath>
                      </text>
                    </>
                  ) : null}
                </g>
              )
            })}

            {layout.leaves.map((l) => {
              const node = l.node
              const pal = index.palette.get(l.parentId ?? "") ?? index.paletteOf(l.id)
              const em = leafEmphasis(highlight, l.id)
              const outOfFocus = !!focusId && focusId !== l.parentId
              const selected = selectedId === l.id
              const peek = peekId === l.id
              const share = node.friction.share
              const friction = lens === "friction"
              const fill = friction ? frictionFill(share) : pal.leaf
              const stroke = friction ? frictionStroke(share) : em === "match" ? "var(--brand)" : pal.leafStroke
              const strokeWidth = friction ? frictionRingWidth(share) : em === "match" ? 1.75 : 1
              const textColor = friction ? frictionLabelColor(share) : "oklch(0.24 0.01 285)"
              const subColor = friction ? textColor : "oklch(0.44 0.01 285)"
              const lab = labels?.leaf.get(l.id) ?? null
              const liveConv = node.conversations + (liveDelta?.get(l.id) ?? 0)
              const lines = lab?.lines ?? null
              const showSub = !!lab?.sub
              const fontPx = lab?.fontSize ?? 11
              const lineH = (lab?.lineHeight ?? 12.8) / k
              const blockLines = (lines?.length ?? 0) + (showSub ? 1 : 0)
              const top = l.y - ((blockLines - 1) * lineH) / 2
              return (
                <g
                  key={l.id}
                  className="map-node map-anim"
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.title}: ${fmtInt(node.conversations)} conversations (${fmtPct(node.share)} of all), ${fmtInt(node.users)} people, friction ${fmtPct(share)}${node.surprising?.flag ? ", flagged surprising" : ""}.`}
                  aria-pressed={selected}
                  style={{ opacity: outOfFocus ? Math.min(0.28, OPACITY[em]) : OPACITY[em] }}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleLeaf(l)
                  }}
                  onKeyDown={(e) => onKey(e, () => handleLeaf(l))}
                  onMouseEnter={() => setHover(l.id)}
                  onMouseLeave={() => setHover((h) => (h === l.id ? null : h))}
                  onFocus={() => setHover(l.id)}
                  onBlur={() => setHover((h) => (h === l.id ? null : h))}
                >
                  <circle className="focus-ring" cx={l.x} cy={l.y} r={l.r + 4 / k} fill="none" stroke="var(--ring)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  {l.r * k < 7 ? <circle cx={l.x} cy={l.y} r={7 / k} fill="transparent" /> : null}
                  {selected || peek ? (
                    <circle
                      cx={l.x}
                      cy={l.y}
                      r={l.r + (selected ? 3.5 : 2.5) / k}
                      fill="none"
                      stroke={selected ? "var(--foreground)" : "var(--brand)"}
                      strokeWidth={selected ? 2.25 : 1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                  <circle
                    className="map-anim"
                    cx={l.x}
                    cy={l.y}
                    r={Math.max(0.5, l.r - (friction ? strokeWidth / (2 * k) : 0))}
                    fill={fill}
                    stroke={hover === l.id && !friction ? pal.label : stroke}
                    strokeWidth={strokeWidth}
                    strokeDasharray={em === "partial" || (node.is_other && !friction) ? "3 2.5" : undefined}
                    vectorEffect="non-scaling-stroke"
                  />
                  {lines && !outOfFocus ? (
                    <text
                      x={l.x}
                      textAnchor="middle"
                      fontSize={fontPx / k}
                      fontWeight={500}
                      fill={textColor}
                      style={{ pointerEvents: "none" }}
                    >
                      {lines.map((line, i) => (
                        <tspan key={i} x={l.x} y={top + i * lineH} dominantBaseline="central">
                          {line}
                        </tspan>
                      ))}
                      {showSub ? (
                        <tspan
                          x={l.x}
                          y={top + lines.length * lineH + 1 / k}
                          dominantBaseline="central"
                          fontFamily="var(--font-mono)"
                          fontSize={(fontPx - 1) / k}
                          fontWeight={friction ? 600 : 450}
                          fill={subColor}
                        >
                          {friction ? fmtPct(share) : fmtInt(liveConv)}
                        </tspan>
                      ) : null}
                    </text>
                  ) : null}
                </g>
              )
            })}
            {/* straight labels for categories too small for a curved one; drawn
                last so no circle paints over them; placement avoids other categories */}
            <g aria-hidden style={{ pointerEvents: "none" }}>
              {layout.categories.map((c) => {
                const lab = labels?.cat.get(c.id)
                if (!lab || lab.mode !== "outside") return null
                const outOfFocus = !!focusId && focusId !== c.id
                if (outOfFocus) return null
                const em = categoryEmphasis(highlight, c.id)
                const pal = index.palette.get(c.id)!
                return (
                  <text
                    key={c.id}
                    className="map-anim"
                    x={lab.x}
                    y={lab.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={lab.fontSize / k}
                    fontWeight={560}
                    fill={lens === "friction" ? "oklch(0.4 0.008 285)" : pal.label}
                    stroke="var(--card)"
                    strokeWidth={3.5 / k}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    style={{ opacity: em === "dim" ? 0.4 : 1 }}
                  >
                    {lab.text}
                  </text>
                )
              })}
            </g>
          </g>
        </svg>
      ) : null}

      {/* tooltip */}
      {intake && width > 0 ? (
        <IntakeOverlay
          visual={intake.visual}
          width={width}
          height={height}
          targetOf={targetOf}
          colorOf={colorOf}
          decided={intake.decided}
          total={intake.total}
          obstacles={obstacles}
        />
      ) : null}
      {hovered && layout ? <MapTooltip circle={hovered} k={k} tx={tx} ty={ty} width={width} height={height} total={total} lens={lens} /> : null}
      </div>
      {width > 0 && width < KEY_BELOW_WIDTH ? <CategoryKey index={index} focusId={focusId} onFocusCategory={onFocusCategory} /> : null}
      <MapLegend lens={lens} />
    </div>
  )
}

/** Compact category key for narrow maps, where curved labels rarely fit. */
function CategoryKey({
  index,
  focusId,
  onFocusCategory,
}: {
  index: SnapshotIndex
  focusId: string | null
  onFocusCategory: (id: string | null) => void
}) {
  return (
    <ul aria-label="Categories" className="flex flex-wrap gap-1.5 px-3 pb-2">
      {index.categories.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onFocusCategory(focusId === c.id ? null : c.id)}
            aria-pressed={focusId === c.id}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11.5px] transition-colors",
              focusId === c.id ? "border-foreground/30 bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: index.palette.get(c.id)?.dot }} />
            {labelText(c)}
          </button>
        </li>
      ))}
    </ul>
  )
}

export function MapBar({
  index,
  focusNode,
  onFocusCategory,
  lens,
  onLens,
  extra,
}: {
  index: SnapshotIndex
  focusNode: SnapshotIndex["categories"][number] | null
  onFocusCategory: (id: string | null) => void
  lens: Lens
  onLens: (lens: Lens) => void
  extra?: ReactNode
}) {
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5">
      <nav aria-label="Map focus" className="flex min-w-0 items-center gap-1 text-[12.5px]">
        <button
          type="button"
          className={cn(
            "rounded-md px-1.5 py-0.5 font-medium whitespace-nowrap transition-colors",
            focusNode ? "text-muted-foreground hover:bg-muted hover:text-foreground" : "text-foreground",
          )}
          onClick={() => onFocusCategory(null)}
          aria-current={focusNode ? undefined : "page"}
        >
          All workflows
        </button>
        {focusNode ? (
          <>
            <ChevronRight aria-hidden className="size-3.5 shrink-0 text-subtle" />
            <span className="truncate rounded-md px-1.5 py-0.5 font-medium text-foreground" aria-current="page">
              {focusNode.title}
            </span>
          </>
        ) : null}
      </nav>
      <div className="flex shrink-0 items-center gap-3">
        <span className="hidden text-[11.5px] text-muted-foreground sm:inline">
          {index.leaves.length} workflows · {index.categories.length} categories
          {focusNode ? <span className="text-subtle"> · Esc to step back</span> : null}
        </span>
        {extra}
        {/* A view of published data: recolours instantly, no run and no network. */}
        <div role="radiogroup" aria-label="Map lens" className="inline-flex rounded-lg border p-0.5 text-[12px]">
          {(["usage", "friction"] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={lens === l}
              onClick={() => onLens(l)}
              className={cn(
                "rounded-md px-2.5 py-0.5 transition-colors",
                lens === l
                  ? l === "friction"
                    ? "bg-heat-soft font-medium text-heat"
                    : "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {l === "usage" ? "Usage" : "Friction"}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function MapTooltip({
  circle,
  k,
  tx,
  ty,
  width,
  total,
  lens,
}: {
  circle: PackedCircle
  k: number
  tx: number
  ty: number
  width: number
  height: number
  total: number
  lens: Lens
}) {
  const n = circle.node
  const cx = circle.x * k + tx
  const topY = (circle.y - circle.r) * k + ty
  const botY = (circle.y + circle.r) * k + ty
  const W = 248
  const left = Math.min(Math.max(8, cx - W / 2), width - W - 8)
  const above = topY > 118
  const style = above ? { left, top: topY - 8, transform: "translateY(-100%)" } : { left, top: botY + 8 }
  const share = n.friction.share
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-20 w-[248px] rounded-lg border bg-popover/95 px-3 py-2.5 text-[12px] shadow-[0_6px_24px_-8px_rgb(0_0_0/0.18)] backdrop-blur-sm"
      style={style}
    >
      <div className="mb-1.5 text-[12.5px] leading-snug font-medium text-foreground">
        {n.title}
        {circle.kind === "category" ? <span className="ml-1 text-muted-foreground">· category</span> : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">Conversations</dt>
        <dd className="text-right font-mono">
          {fmtInt(n.conversations)} <span className="text-muted-foreground">· {fmtPct(total ? n.conversations / total : null)}</span>
        </dd>
        <dt className="text-muted-foreground">People</dt>
        <dd className="text-right font-mono">{fmtInt(n.users)}</dd>
        <dt className={cn("text-muted-foreground", lens === "friction" && "text-foreground")}>Friction</dt>
        <dd className={cn("text-right font-mono", lens === "friction" && "font-semibold")}>
          {fmtPct(share)} <span className="font-normal text-muted-foreground">· {fmtInt(n.friction.conversations)}</span>
        </dd>
      </dl>
      {circle.kind === "leaf" && n.surprising?.flag ? <div className="mt-1.5 text-[11px] text-brand">Surprising use</div> : null}
    </div>
  )
}

function MapLegend({ lens }: { lens: Lens }) {
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-2 text-[11.5px] text-muted-foreground">
      {lens === "friction" ? (
        <>
          <span className="font-medium text-foreground">Friction · share with ≥1 observed signal</span>
          <span className="flex items-center gap-2.5" role="img" aria-label="Friction scale from 0% to 30% or more; darker fill and a thicker ring mean more friction">
            {FRICTION_LEGEND.map((s) => (
              <span key={s} className="flex items-center gap-1">
                <svg width="14" height="14" aria-hidden>
                  <circle cx="7" cy="7" r={6.5 - frictionRingWidth(s) / 2} fill={frictionFill(s)} stroke={frictionStroke(s)} strokeWidth={frictionRingWidth(s)} />
                </svg>
                <span className="font-mono text-[10.5px] tabular-nums">
                  {Math.round(s * 100)}%{s >= FRICTION_MAX ? "+" : ""}
                </span>
              </span>
            ))}
          </span>
          <span>thicker ring = more · size = conversations</span>
        </>
      ) : (
        <span>Circle area = conversations · position carries no meaning · click a category to zoom</span>
      )}
    </div>
  )
}
