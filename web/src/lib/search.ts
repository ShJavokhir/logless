import type { Node as SnapshotNode, SearchResponse } from "./types"

export type Emphasis = "match" | "partial" | "dim" | "none"

export type HighlightState = {
  /** a search is applied (results received for a non-empty query) */
  active: boolean
  /** active search with zero relevant/unclear clusters */
  empty: boolean
  clusters: Map<string, "match" | "partial">
  categories: Set<string>
  matchCount: number
}

export const NO_HIGHLIGHT: HighlightState = {
  active: false,
  empty: false,
  clusters: new Map(),
  categories: new Set(),
  matchCount: 0,
}

/**
 * Derives highlight state from a search response. `relevant` clusters are
 * matches, `unclear` ones are partial (shown with a dashed outline, half-dim),
 * everything else dims. Parent categories of any match stay highlighted.
 */
export function highlightFromResults(
  response: Pick<SearchResponse, "results"> | null,
  clusters: Pick<SnapshotNode, "id" | "parent_id">[],
): HighlightState {
  if (!response) return NO_HIGHLIGHT
  const parentOf = new Map(clusters.map((c) => [c.id, c.parent_id]))
  const marks = new Map<string, "match" | "partial">()
  const cats = new Set<string>()
  let matchCount = 0
  for (const r of response.results) {
    if (!parentOf.has(r.cluster_id)) continue // unknown ids are ignored
    if (r.relevance === "relevant") {
      marks.set(r.cluster_id, "match")
      matchCount++
    } else if (r.relevance === "unclear") {
      marks.set(r.cluster_id, "partial")
    } else continue
    const parent = parentOf.get(r.cluster_id)
    if (parent) cats.add(parent)
  }
  return { active: true, empty: marks.size === 0, clusters: marks, categories: cats, matchCount }
}

export function leafEmphasis(state: HighlightState, id: string): Emphasis {
  if (!state.active) return "none"
  return state.clusters.get(id) ?? "dim"
}

export function categoryEmphasis(state: HighlightState, id: string): Emphasis {
  if (!state.active) return "none"
  return state.categories.has(id) ? "match" : "dim"
}

/**
 * Tracks request order so only the latest search response is applied.
 * `begin()` returns a token; `isCurrent(token)` is false once a newer search began
 * or the search was cleared.
 */
export function createLatestGuard() {
  let seq = 0
  return {
    begin: () => ++seq,
    invalidate: () => {
      seq++
    },
    isCurrent: (token: number) => token === seq,
  }
}

/**
 * Highlight for a verified question result: leaf rows are matches (their
 * category lights up); category rows light the category and all its leaves.
 */
export function highlightFromRows(
  rowIds: string[],
  clusters: Pick<SnapshotNode, "id" | "parent_id">[],
): HighlightState {
  const parentOf = new Map(clusters.map((c) => [c.id, c.parent_id]))
  const marks = new Map<string, "match" | "partial">()
  const cats = new Set<string>()
  for (const id of rowIds) {
    if (parentOf.has(id)) {
      marks.set(id, "match")
      const p = parentOf.get(id)
      if (p) cats.add(p)
    } else {
      cats.add(id)
      for (const c of clusters) if (c.parent_id === id) marks.set(c.id, "match")
    }
  }
  return { active: rowIds.length > 0, empty: marks.size === 0 && cats.size === 0, clusters: marks, categories: cats, matchCount: marks.size }
}
