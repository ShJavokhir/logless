// Label fitting for the circle map. Text is measured with a canvas using the
// real UI font (falls back to an estimate outside the browser, e.g. in tests),
// and each line gets the chord width available at its own height in the circle.

export type Measure = (text: string, fontSize: number, weight?: number, letterSpacing?: number) => number

export const estimateMeasure: Measure = (text, fontSize, _weight = 500, letterSpacing = 0) =>
  text.length * fontSize * 0.56 + letterSpacing * text.length

let ctx: CanvasRenderingContext2D | null | undefined
const cache = new Map<string, number>()
const FAMILY = '"Geist Variable", ui-sans-serif, system-ui, sans-serif'

/** Canvas text measurement with the UI font; cached. */
export const canvasMeasure: Measure = (text, fontSize, weight = 500, letterSpacing = 0) => {
  if (typeof document === "undefined") return estimateMeasure(text, fontSize, weight, letterSpacing)
  if (ctx === undefined) ctx = document.createElement("canvas").getContext("2d")
  if (!ctx) return estimateMeasure(text, fontSize, weight, letterSpacing)
  const key = `${weight}|${fontSize}|${letterSpacing}|${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  ctx.font = `${weight} ${fontSize}px ${FAMILY}`
  const w = ctx.measureText(text).width + letterSpacing * Math.max(0, text.length - 1)
  cache.set(key, w)
  return w
}

/** Drop cached widths (call after web fonts finish loading). */
export function resetMeasureCache() {
  cache.clear()
}

/** Map label text: `short_title` when present, else the full title. */
export function labelText(node: { title: string; short_title?: string }): string {
  const s = node.short_title?.trim()
  return s ? s : node.title
}

export type CircleLabel = { lines: string[]; fontSize: number; lineHeight: number; sub: boolean }

type FitOpts = {
  maxFont?: number
  minFont?: number
  maxLines?: number
  /** reserve a smaller second line (count or %) under the label when it fits */
  subLine?: boolean
  pad?: number
  measure?: Measure
  weight?: number
}

/** Width available for line `i` of an `n`-line block centred in a circle of radius r. */
function lineWidths(r: number, n: number, lineHeight: number, pad: number): number[] {
  const blockH = n * lineHeight
  return Array.from({ length: n }, (_, i) => {
    const top = -blockH / 2 + i * lineHeight
    const y = Math.max(Math.abs(top), Math.abs(top + lineHeight))
    return y >= r ? 0 : 2 * Math.sqrt(r * r - y * y) - pad
  })
}

function wrap(words: string[], widths: number[], fits: (s: string, w: number) => boolean): string[] | null {
  const out: string[] = []
  let cur = ""
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word
    const line = out.length
    if (line >= widths.length) return null
    if (fits(next, widths[line])) {
      cur = next
      continue
    }
    if (!cur) return null
    out.push(cur)
    cur = word
    if (out.length >= widths.length || !fits(cur, widths[out.length])) return null
  }
  if (cur) out.push(cur)
  return out.length <= widths.length ? out : null
}

/**
 * Largest font (maxFont → minFont, 0.5 px steps) at which `text` wraps into at
 * most `maxLines` lines inside the circle; a sub-line is kept only if it fits at
 * that same font. Returns null when nothing fits.
 */
export function fitCircleLabel(text: string, r: number, opts: FitOpts = {}): CircleLabel | null {
  const { maxFont = 13, minFont = 10, maxLines = 3, subLine = false, pad = 6, measure = estimateMeasure, weight = 500 } = opts
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length || r <= 0) return null
  for (let f = maxFont; f >= minFont - 1e-9; f -= 0.5) {
    const lh = f * 1.16
    const fits = (s: string, w: number) => measure(s, f, weight) <= w
    for (let n = 1; n <= maxLines; n++) {
      if (subLine) {
        const widths = lineWidths(r, n + 1, lh, pad)
        const lines = wrap(words, widths.slice(0, n), fits)
        if (lines && lines.length === n && widths[n] >= measure("0,000", f - 1, 450)) return { lines, fontSize: f, lineHeight: lh, sub: true }
      }
      const widths = lineWidths(r, n, lh, pad)
      if (n * lh > r * 1.7) break
      const lines = wrap(words, widths, fits)
      if (lines && lines.length === n) return { lines, fontSize: f, lineHeight: lh, sub: false }
    }
  }
  return null
}

/** Last resort for mid-size circles: one line at `fontSize`, ellipsized. */
export function ellipsizeLabel(text: string, r: number, fontSize = 10, measure: Measure = estimateMeasure, pad = 6): CircleLabel | null {
  const lh = fontSize * 1.16
  const width = lineWidths(r, 1, lh, pad)[0]
  if (measure(text, fontSize) <= width) return { lines: [text], fontSize, lineHeight: lh, sub: false }
  for (let n = text.length - 1; n >= 3; n--) {
    const s = `${text.slice(0, n).trimEnd()}…`
    if (measure(s, fontSize) <= width) return { lines: [s], fontSize, lineHeight: lh, sub: false }
  }
  return null
}

/** Arc length available for a curved category label along the top of the rim. */
export function arcLabelFits(text: string, labelRadius: number, fontSize: number, letterSpacing: number, measure: Measure, spanDeg = 170): boolean {
  const arc = (Math.PI * labelRadius * spanDeg) / 180
  return measure(text.toUpperCase(), fontSize, 560, letterSpacing) + 12 <= arc
}

/** Name for running prose: the short title unless it was machine-shortened ("…"). */
export function proseName(node: { title: string; short_title?: string }): string {
  const s = node.short_title?.trim()
  return s && !s.endsWith("…") ? s : node.title
}
