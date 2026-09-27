import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useElementSize } from "@/hooks/useElementSize"
import { packLayout, zoomTransform, type PackedCircle } from "@/lib/hierarchy"
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
}

const CAT_FONT = 10.5
const CAT_TRACKING = 0.9
const CAT_BAND = 16 // px between a category rim and its leaves; holds the curved label
const LEAF_MIN_LABEL_R = 22 // every leaf at least this big (on screen) gets a label

type CategoryLabel =
  | { mode: "arc"; text: string; fontSize: number }
  | { mode: "outside"; text: string; fontSize: number; x: number; y: number }

const OPACITY: Record<Emphasis, number> = { none: 1, match: 1, partial: 0.62, dim: 0.14 }

export function UsageMap({ index, lens, highlight, selectedId, focusId, peekId, onSelectLeaf, onFocusCategory }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(boxRef)
  const [hover, setHover] = useState<string | null>(null)

  // Layout depends only on the snapshot and the container size.
  const layout = useMemo(
    () => (width > 40 && height > 40 ? packLayout(index.snapshot, width, height, { categoryPadding: 14, leafPadding: 3, categoryBand: CAT_BAND, margin: 6 }) : null),
    [index.snapshot, width, height],
  )

  const focus = focusId && layout ? layout.byId.get(focusId) ?? null : null
  const { k, tx, ty } = zoomTransform(focus, width, height, 0.92)

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
    for (const c of layout.categories) {
      const text = labelText(c.node)
      const labelR = (c.r - CAT_BAND / 2 + 0.5) * k
      const arcFont = [CAT_FONT, 9.5].find((f) => arcLabelFits(text, labelR, f, CAT_TRACKING, canvasMeasure))
      if (arcFont) {
        cat.set(c.id, { mode: "arc", text: text.toUpperCase(), fontSize: arcFont })
        continue
      }
      // Too small for a curved label: a straight label just outside the rim
      // (below, or above when that would leave the viewport), kept on screen.
      const fs = 11
      const w = canvasMeasure(text, fs, 560)
      const sx = c.x * k + tx
      const sBottom = (c.y + c.r) * k + ty
      const sTop = (c.y - c.r) * k + ty
      const sy = sBottom + fs + 4 <= height - 2 ? sBottom + fs * 0.5 + 4 : sTop - fs * 0.5 - 4
      const clampedX = Math.min(Math.max(sx, w / 2 + 4), width - w / 2 - 4)
      cat.set(c.id, { mode: "outside", text, fontSize: fs, x: (clampedX - tx) / k, y: (sy - ty) / k })
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
      className="flex h-full min-h-[420px] w-full flex-col select-none"
      onKeyDown={(e) => {
        if (e.key === "Escape" && focusId) {
          e.stopPropagation()
          onFocusCategory(null)
        }
      }}
    >
      <MapBar index={index} focusNode={focusNode ?? null} onFocusCategory={onFocusCategory} lens={lens} />
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden">
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

            {/* straight labels for categories too small for a curved one; drawn
                above every category circle so no neighbour paints over them */}
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
                          {friction ? fmtPct(share) : fmtInt(node.conversations)}
                        </tspan>
                      ) : null}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </g>
        </svg>
      ) : null}

      {/* tooltip */}
      {hovered && layout ? <MapTooltip circle={hovered} k={k} tx={tx} ty={ty} width={width} height={height} total={total} lens={lens} /> : null}
      </div>
      <MapLegend lens={lens} />
    </div>
  )
}

export function MapBar({
  index,
  focusNode,
  onFocusCategory,
  lens,
}: {
  index: SnapshotIndex
  focusNode: SnapshotIndex["categories"][number] | null
  onFocusCategory: (id: string | null) => void
  lens: Lens
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 px-3">
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
      <span className="shrink-0 text-[11.5px] text-muted-foreground">
        {lens === "friction" ? (
          <span className="font-medium text-heat">Friction lens</span>
        ) : (
          <>
            {index.leaves.length} workflows · {index.categories.length} categories
          </>
        )}
        {focusNode ? <span className="text-subtle"> · Esc to step back</span> : null}
      </span>
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
