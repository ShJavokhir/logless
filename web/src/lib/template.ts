// Fills `{{metric}}` placeholders in a model-written explanation from the
// gate-validated `result`. The model never supplies numbers: every value shown
// is read from the result object (or a snapshot title for a cluster id).
//
// Placeholder convention (proposal, see report):
//   {{total_conversations}}             top-level result field
//   {{rows.0.conversations}}            dotted path, numeric array index
//   {{rows[0].friction_share}}          bracket index is accepted too
//   {{rows.0.cluster_id}}               cluster ids render as the cluster title
// Fields named `share` or ending in `_share` render as percentages; other
// numbers render as integers with separators. Unresolvable placeholders stay
// visible (kind "missing") instead of silently disappearing.

import { fmtInt, fmtPct } from "./format"

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "metric"; text: string; key: string }
  | { kind: "missing"; text: string; key: string }

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g

export function resolvePath(obj: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined
      cur = cur[Number(part)]
    } else if (typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return cur
}

function lastKey(path: string): string {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".")
  return parts[parts.length - 1] ?? ""
}

export function formatValue(key: string, value: unknown, titleOf?: (clusterId: string) => string | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    if (key === "share" || key.endsWith("_share")) return fmtPct(value)
    return fmtInt(value)
  }
  if (typeof value === "string") {
    if (key === "cluster_id" || key === "category_id") return titleOf?.(value) ?? value
    return value
  }
  return null
}

export function fillTemplate(
  text: string,
  result: unknown,
  titleOf?: (clusterId: string) => string | undefined,
): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(PLACEHOLDER)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ kind: "text", text: text.slice(last, idx) })
    const key = m[1]
    const formatted = formatValue(lastKey(key), resolvePath(result, key), titleOf)
    out.push(formatted === null ? { kind: "missing", text: "unavailable", key } : { kind: "metric", text: formatted, key })
    last = idx + m[0].length
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) })
  return out
}

export function segmentsToString(segs: Segment[]): string {
  return segs.map((s) => s.text).join("")
}
