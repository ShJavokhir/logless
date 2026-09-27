import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ChevronRight, Minus, Plus, Scan } from "lucide-react"
import { cn } from "@/lib/utils"
import { useElementSize } from "@/hooks/useElementSize"
import { layoutOrderOf, packLayout, zoomTransform, type PackedCircle } from "@/lib/hierarchy"
import type { Snapshot } from "@/lib/types"
import { useLayoutTween } from "@/hooks/useLayoutTween"
import { useMapCamera } from "@/hooks/useMapCamera"
import { categoryDetail, smoothStep } from "@/lib/mapCamera"
import { canvasMeasure, ellipsizeLabel, fitCircleLabel, labelText, resetMeasureCache, type CircleLabel } from "@/lib/labels"
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
  /** extra control in the map header (presenter-only live intake) */
  headerControl?: ReactNode
}

const PACK = { categoryPadding: 14, leafPadding: 3, categoryBand: 16, margin: 6 }

const CAT_BAND = 16 // px between a category rim and its leaves; holds the curved label
const LEAF_MIN_LABEL_R = 22 // every leaf at least this big (on screen) gets a label
const KEY_BELOW_WIDTH = 560 // narrower maps get a category key instead of straight labels

const OPACITY: Record<Emphasis, number> = { none: 1, match: 1, partial: 0.62, dim: 0.14 }

function focusTransform(circle: PackedCircle, width: number, height: number) {
  const k = Math.max(1.8, zoomTransform(circle, width, height, 0.88).k)
  return { k, tx: width / 2 - circle.x * k, ty: height / 2 - circle.y * k }
}

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
  headerControl,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const { width, height: boxHeight } = useElementSize(boxRef)
  // A dedicated control strip keeps navigation clear of even the smallest bubble.
  const height = Math.max(0, boxHeight - 52)
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

  const exploring = useRef(false)
  const { k, tx, ty, move: moveCamera, reset: resetCamera, zoom: zoomCamera, pan: panCamera,
    surfaceRef, interacting, dragging, canZoomIn } = useMapCamera(width, height, reduceMotion, () => {
    if (focusId) {
      exploring.current = true
      onFocusCategory(null)
    }
  })
  if (interacting && hover) setHover(null)
  const layoutRef = useRef(layout)
  useEffect(() => { layoutRef.current = layout }, [layout])
  const previousFocus = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousFocus.current
    previousFocus.current = focusId
    if (exploring.current && !focusId) {
      exploring.current = false
      return
    }
    const focus = focusId ? layoutRef.current?.byId.get(focusId) : null
    if (focus) moveCamera(focusTransform(focus, width, height))
    else if (previous) resetCamera()
  }, [focusId, width, height, moveCamera, resetCamera])

  const resetMap = () => {
    onFocusCategory(null)
    onSelectLeaf(null)
    resetCamera()
  }
  const detailOf = (c: PackedCircle) => highlight.active || (selectedId && index.byId.get(selectedId)?.parent_id === c.id)
    ? 1 : categoryDetail(k, c.r, Math.min(width, height))

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
    const cat = new Map<string, CircleLabel | null>()
    for (const c of layout.categories) {
      // Screen-space type stays readable as the camera moves. Overview labels
      // fit inside a quiet centre; child labels take over before they overlap.
      const rs = c.r * k
      cat.set(c.id, fitCircleLabel(labelText(c.node), rs * 0.92, {
        maxFont: Math.min(23, Math.max(13, rs * 0.17)), minFont: 10,
        maxLines: 3, subLine: rs >= 42, measure: canvasMeasure, weight: 600,
      }) ?? ellipsizeLabel(labelText(c.node), rs * 0.9, 11, canvasMeasure))
    }
    return { leaf, cat }
  }, [layout, k, fontsReady])

  const onKey = useCallback((e: KeyboardEvent, fn: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      fn()
    }
  }, [])

  const handleLeaf = (leaf: PackedCircle) => {
    const parent = layout?.byId.get(leaf.parentId ?? "")
    if (parent && detailOf(parent) < 0.55) {
      handleCategory(parent)
      return
    }
    if (focusId && leaf.parentId !== focusId) onFocusCategory(leaf.parentId)
    onSelectLeaf(leaf.id)
  }

  const handleCategory = (cat: PackedCircle) => {
    moveCamera(focusTransform(cat, width, height))
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
        if (e.key === "Escape" && (focusId || k > 1.01)) {
          e.stopPropagation()
          resetMap()
        }
      }}
    >
      <MapBar index={index} focusNode={focusNode ?? null} onFocusCategory={() => resetMap()} lens={lens} onLens={onLens} extra={headerControl} />
      <div ref={boxRef} className="relative aspect-square min-h-0 w-full overflow-hidden lg:aspect-auto lg:flex-1">
      {layout ? (
        <svg
          ref={surfaceRef}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomCamera(1.4) }
            if (e.key === "-") { e.preventDefault(); zoomCamera(1 / 1.4) }
            if (e.key === "0" || e.key === "Home") { e.preventDefault(); resetMap() }
            const delta = { ArrowLeft: [64, 0], ArrowRight: [-64, 0], ArrowUp: [0, 64], ArrowDown: [0, -64] }[e.key]
            if (delta) {
              e.preventDefault()
              panCamera(delta[0], delta[1])
            }
          }}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="map-surface block focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          style={{ cursor: dragging ? "grabbing" : k > 1.01 ? "grab" : "default", touchAction: "none" }}
          role="group"
          aria-label={`Usage map. ${index.leaves.length} workflow clusters in ${index.categories.length} categories; circle area is proportional to conversations. Scroll or pinch to zoom; drag to pan. Keyboard: plus and minus to zoom, arrows to pan, Escape to reset. Use the list view for a table.`}
        >
          <rect
            width={width}
            height={height}
            fill="transparent"
            onClick={() => {
              onSelectLeaf(null)
            }}
          />
          <g className="map-zoom" style={{ transform: `translate(${tx}px, ${ty}px) scale(${k})` }}>
            {layout.categories.map((c) => {
              const pal = index.palette.get(c.id)!
              const em = categoryEmphasis(highlight, c.id)
              const outOfFocus = !!focusId && focusId !== c.id
              const node = c.node
              const labelR = c.r - CAT_BAND / 2 + 0.5
              const detail = detailOf(c)
              const friction = lens === "friction"
              return (
                <g
                  key={c.id}
                  className="map-node map-anim"
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.title} category: ${fmtInt(node.conversations)} conversations, ${fmtInt(node.users)} people, friction ${fmtPct(node.friction.share)}. ${focusId === c.id ? "Focused." : "Press Enter to focus."}`}
                  aria-pressed={focusId === c.id}
                  style={{ opacity: outOfFocus ? 0.32 : em === "dim" ? 0.4 : 1, cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCategory(c)
                  }}
                  onKeyDown={(e) => onKey(e, () => handleCategory(c))}
                  onMouseEnter={() => { if (!interacting) setHover(c.id) }}
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
                  {detail > 0.01 && !outOfFocus ? (
                    <g opacity={detail * 0.85} aria-hidden="true" style={{ pointerEvents: "none" }}>
                      <path id={`arc-${c.id}`} d={`M ${c.x - labelR} ${c.y} A ${labelR} ${labelR} 0 0 1 ${c.x + labelR} ${c.y}`} fill="none" />
                      <text fontSize={10.5 / k} fontWeight={560} letterSpacing={0.9 / k}
                        fill={friction ? "oklch(0.45 0.008 285)" : pal.label} dominantBaseline="central">
                        <textPath href={`#arc-${c.id}`} startOffset="50%" textAnchor="middle">
                          {labelText(node).toUpperCase()}
                        </textPath>
                      </text>
                    </g>
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
              const parent = layout.byId.get(l.parentId ?? "")
              const detail = parent ? detailOf(parent) : 1
              const labelOpacity = detail * smoothStep(16, 30, l.r * k)
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
                  tabIndex={detail > 0.55 && !outOfFocus ? 0 : -1}
                  aria-hidden={detail <= 0.55 || outOfFocus}
                  aria-label={`${node.title}: ${fmtInt(node.conversations)} conversations (${fmtPct(node.share)} of all), ${fmtInt(node.users)} people, friction ${fmtPct(share)}${node.surprising?.flag ? ", flagged surprising" : ""}.`}
                  aria-pressed={selected}
                  style={{ opacity: (outOfFocus ? Math.min(0.28, OPACITY[em]) : OPACITY[em]) * (0.16 + 0.84 * detail), cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleLeaf(l)
                  }}
                  onKeyDown={(e) => onKey(e, () => handleLeaf(l))}
                  onMouseEnter={() => { if (!interacting) setHover(detail > 0.55 ? l.id : l.parentId) }}
                  onMouseLeave={() => setHover(null)}
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
                  {lines && !outOfFocus && labelOpacity > 0.01 ? (
                    <text
                      x={l.x}
                      opacity={labelOpacity}
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
            {/* Overview names sit above the faint child bubbles and dissolve as
                the real workflow labels come into focus. No relayout on zoom. */}
            <g aria-hidden="true" style={{ pointerEvents: "none" }}>
              {layout.categories.map((c) => {
                const lab = labels?.cat.get(c.id)
                const detail = detailOf(c)
                if (!lab || detail >= 0.995) return null
                const pal = index.palette.get(c.id)!
                const opacity = (1 - smoothStep(0, 0.72, detail)) * (focusId && focusId !== c.id ? 0.28 : 1)
                const lineH = lab.lineHeight / k
                const sub = lab.sub && c.r * k >= 42
                const metric = lens === "friction" ? fmtPct(c.node.friction.share) : fmtInt(c.node.conversations)
                const caption = `${metric} ${lens === "friction" ? "friction" : "conversations"}`
                const subText = canvasMeasure(caption, 10.5) <= c.r * k * 1.6 ? caption : metric
                const top = c.y - ((lab.lines.length - 1) * lineH + (sub ? 19 / k : 0)) / 2
                return (
                  <g key={c.id} opacity={opacity} data-category-label={c.id}>
                    <text x={c.x} textAnchor="middle" fontSize={lab.fontSize / k} fontWeight={600}
                      fill={lens === "friction" ? "var(--foreground)" : pal.label}
                      stroke={lens === "friction" ? "var(--card)" : pal.fill} strokeWidth={5 / k}
                      strokeLinejoin="round" paintOrder="stroke">
                      {lab.lines.map((line, i) => <tspan key={i} x={c.x} y={top + i * lineH} dominantBaseline="central">{line}</tspan>)}
                    </text>
                    {sub ? <text x={c.x} y={top + (lab.lines.length - 1) * lineH + 20 / k}
                      textAnchor="middle" dominantBaseline="central" fontSize={10.5 / k}
                      fontFamily="var(--font-mono)" fill={pal.label} opacity={0.8}
                      stroke={pal.fill} strokeWidth={3 / k} paintOrder="stroke">
                      {subText}
                    </text> : null}
                  </g>
                )
              })}
            </g>
          </g>
        </svg>
      ) : null}

      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-2">
        <div className="rounded-full border border-border/60 bg-card/90 px-3 py-1.5 text-[11px] text-muted-foreground shadow-xs backdrop-blur-md">
          <span className="hidden sm:inline">{k > 1.15 ? "Drag to explore · scroll to zoom" : "Scroll to explore the workflows"}</span>
          <span className="sm:hidden">{k > 1.15 ? "Drag or pinch to explore" : "Pinch or tap to explore"}</span>
        </div>
        <div role="group" aria-label="Map zoom controls" className="pointer-events-auto flex shrink-0 items-center rounded-xl border bg-card/95 p-1 shadow-sm backdrop-blur-md">
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={k < 1.01} onClick={() => zoomCamera(1 / 1.45)} className="map-zoom-button"><Minus className="size-4" /></button>
          <span aria-hidden="true" className="w-11 text-center font-mono text-[10px] tabular-nums text-muted-foreground">{k.toFixed(1)}×</span>
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={!canZoomIn} onClick={() => zoomCamera(1.45)} className="map-zoom-button"><Plus className="size-4" /></button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button type="button" aria-label="Reset map zoom" title="Show all categories (Esc)" disabled={k < 1.01 && !selectedId && !focusId} onClick={resetMap} className="map-zoom-button"><Scan className="size-4" /></button>
        </div>
      </div>
      {/* tooltip */}
      {hovered && layout && !interacting && !dragging ? <MapTooltip circle={hovered} k={k} tx={tx} ty={ty} width={width} height={height} total={total} lens={lens} /> : null}
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
          <span className="flex items-center gap-2.5" role="img" aria-label={`Friction scale from 0% to ${Math.round(FRICTION_MAX * 100)}% or more; darker fill and a thicker ring mean more friction`}>
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
        <span>Circle area = conversations · position carries no meaning</span>
      )}
    </div>
  )
}
